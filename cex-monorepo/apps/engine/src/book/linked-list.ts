export class ListNode<T> {
  value: T;
  prev: ListNode<T> | null = null;
  next: ListNode<T> | null = null;
  list: DoublyLinkedList<T> | null = null;

  constructor(value: T) {
    this.value = value;
  }
}

export class DoublyLinkedList<T> {
  private _head: ListNode<T> | null = null;
  private _tail: ListNode<T> | null = null;
  private _size = 0;

  get head(): ListNode<T> | null {
    return this._head;
  }

  get tail(): ListNode<T> | null {
    return this._tail;
  }

  get size(): number {
    return this._size;
  }

  get isEmpty(): boolean {
    return this._size === 0;
  }

  first(): ListNode<T> | null {
    return this._head;
  }

  last(): ListNode<T> | null {
    return this._tail;
  }

  pushBack(value: T): ListNode<T> {
    const node = new ListNode(value);
    node.list = this;

    if (!this._head || !this._tail) {
      this._head = node;
      this._tail = node;
    } else {
      node.prev = this._tail;
      this._tail.next = node;
      this._tail = node;
    }

    this._size += 1;
    return node;
  }

  remove(node: ListNode<T>): boolean {
    if (node.list !== this) {
      return false;
    }

    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this._head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this._tail = node.prev;
    }

    node.prev = null;
    node.next = null;
    node.list = null;
    this._size -= 1;
    return true;
  }

  *iterate(): IterableIterator<T> {
    let current = this._head;
    while (current !== null) {
      yield current.value;
      current = current.next;
    }
  }

  toArray(): T[] {
    const result: T[] = [];
    let current = this._head;
    while (current !== null) {
      result.push(current.value);
      current = current.next;
    }
    return result;
  }

  clear(): void {
    let current = this._head;
    while (current !== null) {
      const next = current.next;
      current.prev = null;
      current.next = null;
      current.list = null;
      current = next;
    }
    this._head = null;
    this._tail = null;
    this._size = 0;
  }
}
