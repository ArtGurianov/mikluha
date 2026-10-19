/** Indexed min-heap: settled entries leave immediately, so no stale credentials accumulate. */
export class ExpiryQueue<T extends { readonly expiresAt: number }> {
  readonly #items: T[] = [];
  readonly #indices = new Map<T, number>();

  get size(): number { return this.#items.length; }
  peek(): T | undefined { return this.#items[0]; }

  add(value: T): void {
    if (this.#indices.has(value)) return;
    const i = this.#items.length;
    this.#items.push(value);
    this.#indices.set(value, i);
    this.#up(i);
  }

  delete(value: T): boolean {
    const i = this.#indices.get(value);
    if (i === undefined) return false;
    const last = this.#items.pop()!;
    this.#indices.delete(value);
    if (i === this.#items.length) return true;
    this.#items[i] = last;
    this.#indices.set(last, i);
    const parent = Math.floor((i - 1) / 2);
    if (i > 0 && last.expiresAt < this.#items[parent]!.expiresAt) this.#up(i);
    else this.#down(i);
    return true;
  }

  #swap(a: number, b: number): void {
    const first = this.#items[a]!;
    const second = this.#items[b]!;
    this.#items[a] = second;
    this.#items[b] = first;
    this.#indices.set(first, b);
    this.#indices.set(second, a);
  }

  #up(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.#items[parent]!.expiresAt <= this.#items[i]!.expiresAt) break;
      this.#swap(parent, i);
      i = parent;
    }
  }

  #down(index: number): void {
    let i = index;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= this.#items.length) return;
      const right = left + 1;
      const child = right < this.#items.length && this.#items[right]!.expiresAt < this.#items[left]!.expiresAt
        ? right : left;
      if (this.#items[i]!.expiresAt <= this.#items[child]!.expiresAt) return;
      this.#swap(i, child);
      i = child;
    }
  }
}
