export const SCREEN_SHARE_STAGE_SIZE = 4;

// 只管理本地观看位置；移出舞台不停止共享，也不撤销任何媒体权限。
export class ScreenShareStage {
  slots: (string | null)[] = Array(SCREEN_SHARE_STAGE_SIZE).fill(null);
  available: string[] = [];
  focused: string | null = null;
  autoFill = true;
  private excluded = new Set<string>();
  private entered = new Map<string, number>();
  private sequence = 0;

  sync(identities: string[]) {
    const available = new Set(identities);
    // 已观察到的共享保持开始顺序，成员列表刷新或排序不能打乱等待队列。
    this.available = [...this.available.filter((id) => available.has(id)),
      ...identities.filter((id, index) => !this.available.includes(id) && identities.indexOf(id) === index)];
    for (const id of this.excluded) if (!available.has(id)) this.excluded.delete(id);
    this.slots = this.slots.map((id) => {
      if (id && !available.has(id)) { this.entered.delete(id); return null; }
      return id;
    });
    if (this.focused && !this.slots.includes(this.focused)) this.focused = null;
    this.fill();
  }

  setAutoFill(enabled: boolean) {
    this.autoFill = enabled;
    this.fill();
  }

  place(identity: string) {
    if (!this.available.includes(identity) || this.slots.includes(identity)) return;
    let slot = this.slots.indexOf(null);
    if (slot < 0) {
      slot = this.slots.reduce((oldest, id, index) =>
        this.entered.get(id!)! < this.entered.get(this.slots[oldest]!)! ? index : oldest, 0);
      this.removeAt(slot);
    }
    this.excluded.delete(identity);
    this.slots[slot] = identity;
    this.entered.set(identity, ++this.sequence);
  }

  remove(identity: string) {
    const slot = this.slots.indexOf(identity);
    if (slot < 0) return;
    this.removeAt(slot);
    this.fill();
  }

  move(identity: string, target: number) {
    const source = this.slots.indexOf(identity);
    if (source < 0 || !Number.isInteger(target) || target < 0 || target >= SCREEN_SHARE_STAGE_SIZE) return;
    // 交换槽位不改变进入时间；满员时的替换顺序与拖动位置无关。
    [this.slots[source], this.slots[target]] = [this.slots[target], this.slots[source]];
  }

  toggleFocus(identity: string) {
    if (this.slots.includes(identity)) this.focused = this.focused === identity ? null : identity;
  }

  reset() {
    this.slots = Array(SCREEN_SHARE_STAGE_SIZE).fill(null);
    this.available = [];
    this.excluded.clear();
    this.entered.clear();
    this.sequence = 0;
    this.focused = null;
  }

  private removeAt(slot: number) {
    const identity = this.slots[slot];
    if (!identity) return;
    this.excluded.add(identity);
    this.entered.delete(identity);
    this.slots[slot] = null;
    if (this.focused === identity) this.focused = null;
  }

  private fill() {
    if (!this.autoFill) return;
    for (const identity of this.available) {
      if (this.excluded.has(identity) || this.slots.includes(identity)) continue;
      const slot = this.slots.indexOf(null);
      if (slot < 0) break;
      this.slots[slot] = identity;
      this.entered.set(identity, ++this.sequence);
    }
  }
}
