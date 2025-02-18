import { logger } from '@dydxprotocol-indexer/base';
import {
  FillFromDatabase,
  FillModel,
  Liquidity,
  OrderFromDatabase,
  OrderModel,
  OrderTable,
  PerpetualMarketFromDatabase,
  PerpetualMarketModel,
  PerpetualPositionFromDatabase,
  PerpetualPositionModel,
  storeHelpers,
  SubaccountTable,
  USDC_ASSET_ID,
  OrderStatus, FillType,
} from '@dydxprotocol-indexer/postgres';
import { StateFilledQuantumsCache } from '@dydxprotocol-indexer/redis';
import { isStatefulOrder } from '@dydxprotocol-indexer/v4-proto-parser';
import {
  LiquidationOrderV1, IndexerOrderId, OrderFillEventV1,
} from '@dydxprotocol-indexer/v4-protos';
import Long from 'long';
import * as pg from 'pg';

import { STATEFUL_ORDER_ORDER_FILL_EVENT_TYPE, SUBACCOUNT_ORDER_FILL_EVENT_TYPE } from '../../constants';
import { convertPerpetualPosition } from '../../helpers/kafka-helper';
import { redisClient } from '../../helpers/redis/redis-controller';
import {
  orderFillWithLiquidityToOrderFillEventWithLiquidation,
} from '../../helpers/translation-helper';
import { indexerTendermintEventToTransactionIndex } from '../../lib/helper';
import { OrderFillWithLiquidity } from '../../lib/translated-types';
import {
  ConsolidatedKafkaEvent,
  OrderFillEventWithLiquidation,
} from '../../lib/types';
import { AbstractOrderFillHandler } from './abstract-order-fill-handler';

export class LiquidationHandler extends AbstractOrderFillHandler<OrderFillWithLiquidity> {
  eventType: string = 'OrderFillEvent';

  /**
   * @returns the parallelizationIds for the this.event.liquidity order
   */
  public getParallelizationIds(): string[] {
    // OrderFillEvents with the same subaccountId and clobPairId cannot be processed in parallel.
    const liquidatedOrderFill:
    OrderFillEventWithLiquidation = orderFillWithLiquidityToOrderFillEventWithLiquidation(
      this.event,
    );
    if (this.event.liquidity === Liquidity.MAKER) {
      const orderId: IndexerOrderId = liquidatedOrderFill.makerOrder!.orderId!;
      const orderUuid: string = OrderTable.orderIdToUuid(orderId);
      const subaccountUuid: string = SubaccountTable.subaccountIdToUuid(orderId.subaccountId!);
      return [
        `${this.eventType}_${subaccountUuid}_${orderId!.clobPairId}`,
        // To ensure that SubaccountUpdateEvents and OrderFillEvents for the same subaccount are not
        // processed in parallel
        `${SUBACCOUNT_ORDER_FILL_EVENT_TYPE}_${subaccountUuid}`,
        // To ensure that StatefulOrderEvents and OrderFillEvents for the same order are not
        // processed in parallel
        `${STATEFUL_ORDER_ORDER_FILL_EVENT_TYPE}_${orderUuid}`,
      ];
    } else {
      const liquidationOrder: LiquidationOrderV1 = liquidatedOrderFill.liquidationOrder!;
      const subaccountUuid: string = SubaccountTable.subaccountIdToUuid(
        liquidationOrder.liquidated!,
      );
      return [
        `${this.eventType}_${subaccountUuid}_${liquidationOrder.clobPairId}`,
        // To ensure that SubaccountUpdateEvents and OrderFillEvents for the same subaccount are not
        // processed in parallel
        `${SUBACCOUNT_ORDER_FILL_EVENT_TYPE}_${subaccountUuid}`,
        // We do not need to add the StatefulOrderEvent parallelizationId here, because liquidation
        // fills have no order in postgres
      ];
    }
  }

  protected getTotalFilled(castedOrderFillEventMessage: OrderFillEventWithLiquidation): Long {
    return this.event.liquidity === Liquidity.TAKER
      ? castedOrderFillEventMessage.totalFilledTaker
      : castedOrderFillEventMessage.totalFilledMaker;
  }

  public async internalHandle(): Promise<ConsolidatedKafkaEvent[]> {
    const eventDataBinary: Uint8Array = this.indexerTendermintEvent.dataBytes;
    const transactionIndex: number = indexerTendermintEventToTransactionIndex(
      this.indexerTendermintEvent,
    );

    const castedLiquidationFillEventMessage:
    OrderFillEventWithLiquidation = orderFillWithLiquidityToOrderFillEventWithLiquidation(
      this.event,
    );
    const field: string = this.event.liquidity === Liquidity.MAKER
      ? 'makerOrder' : 'liquidationOrder';
    const fillType: string = this.event.liquidity === Liquidity.MAKER
      ? FillType.LIQUIDATION : FillType.LIQUIDATED;

    const result: pg.QueryResult = await storeHelpers.rawQuery(
      `SELECT dydx_liquidation_fill_handler_per_order(
        '${field}', 
        ${this.block.height}, 
        '${this.block.time?.toISOString()}', 
        '${JSON.stringify(OrderFillEventV1.decode(eventDataBinary))}', 
        ${this.indexerTendermintEvent.eventIndex}, 
        ${transactionIndex}, 
        '${this.block.txHashes[transactionIndex]}', 
        '${this.event.liquidity}', 
        '${fillType}',
        '${USDC_ASSET_ID}'
      ) AS result;`,
      { txId: this.txId },
    ).catch((error: Error) => {
      logger.error({
        at: 'liquidationHandler#internalHandle',
        message: 'Failed to handle OrderFillEventV1',
        error,
      });
      throw error;
    });

    const fill: FillFromDatabase = FillModel.fromJson(
      result.rows[0].result.fill) as FillFromDatabase;
    const perpetualMarket: PerpetualMarketFromDatabase = PerpetualMarketModel.fromJson(
      result.rows[0].result.perpetual_market) as PerpetualMarketFromDatabase;
    const position: PerpetualPositionFromDatabase = PerpetualPositionModel.fromJson(
      result.rows[0].result.perpetual_position) as PerpetualPositionFromDatabase;

    if (this.event.liquidity === Liquidity.MAKER) {
      // Must be done in this order, because fills refer to an order
      // We do not create a taker order for liquidations.
      const makerOrder: OrderFromDatabase = OrderModel.fromJson(
        result.rows[0].result.order) as OrderFromDatabase;

      // Update the cache tracking the state-filled amount per order for use in vulcan
      await StateFilledQuantumsCache.updateStateFilledQuantums(
        makerOrder!.id,
        this.getTotalFilled(castedLiquidationFillEventMessage).toString(),
        redisClient,
      );

      const kafkaEvents: ConsolidatedKafkaEvent[] = [
        this.generateConsolidatedKafkaEvent(
          castedLiquidationFillEventMessage.makerOrder.orderId!.subaccountId!,
          makerOrder,
          convertPerpetualPosition(position),
          fill,
          perpetualMarket,
        ),
        // Update vulcan with the total filled amount of the maker order.
        this.getOrderUpdateKafkaEvent(
          castedLiquidationFillEventMessage.makerOrder!.orderId!,
          castedLiquidationFillEventMessage.totalFilledMaker,
        ),
      ];

      // If the order is stateful and fully-filled, send an order removal to vulcan. We only do this
      // for stateful orders as we are guaranteed a stateful order cannot be replaced until the next
      // block.
      if (makerOrder?.status === OrderStatus.FILLED && isStatefulOrder(makerOrder?.orderFlags)) {
        kafkaEvents.push(
          this.getOrderRemoveKafkaEvent(castedLiquidationFillEventMessage.makerOrder!.orderId!),
        );
      }
      return kafkaEvents;
    } else {
      return [
        this.generateConsolidatedKafkaEvent(
          castedLiquidationFillEventMessage.liquidationOrder.liquidated!,
          undefined,
          convertPerpetualPosition(position),
          fill,
          perpetualMarket,
        ),
        this.generateTradeKafkaEventFromTakerOrderFill(
          fill,
        ),
      ];
    }
  }
}
