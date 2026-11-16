import { DoublyLinkedList, ListNode } from './linked-list.js';
import type { EngineOrder } from './types.js';

export class PriceLevel {
  readonly price: bigint;
  totalQuantity: bigint = 0n;
  readonly queue: DoublyLinkedList<EngineOrder> = new DoublyLinkedList<EngineOrder>();

  constructor(price: bigint) {
    this.price = price;
  }

  get orderCount(): number {
    return this.queue.size;
  }

  get isEmpty(): boolean {
    return this.queue.isEmpty;
  }

  add(order: EngineOrder): ListNode<EngineOrder> {
    const remaining = order.quantity - order.filled;
    this.totalQuantity += remaining;
    return this.queue.pushBack(order);
  }

  remove(node: ListNode<EngineOrder>): boolean {
    const remaining = node.value.quantity - node.value.filled;
    const removed = this.queue.remove(node);
    if (removed) {
      this.totalQuantity -= remaining;
      if (this.totalQuantity < 0n) {
        this.totalQuantity = 0n;
      }
    }
    return removed;
  }

  reduce(qty: bigint): void {
    this.totalQuantity -= qty;
    if (this.totalQuantity < 0n) {
      this.totalQuantity = 0n;
    }
  }
}
