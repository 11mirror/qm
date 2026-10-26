export class KeychainOperations {
  private latestLoad = 0;
  private epoch = 0;
  private mutation: symbol | null = null;
  private dropEpoch: number | null = null;
  reset(): void {
    this.latestLoad++;
    this.epoch++;
    this.mutation = null;
    this.dropEpoch = null;
  }
  beginLoad(): number {
    return ++this.latestLoad;
  }
  isCurrentLoad(load: number): boolean {
    return load === this.latestLoad;
  }
  isCurrentEpoch(epoch: number): boolean {
    return epoch === this.epoch;
  }
  captureEpoch(): number {
    return this.epoch;
  }
  beginMutation(): { token: symbol; epoch: number } | null {
    if (this.mutation) return null;
    const token = Symbol();
    this.mutation = token;
    return { token, epoch: this.epoch };
  }
  finishMutation(operation: { token: symbol; epoch: number }): boolean {
    if (!this.isCurrentEpoch(operation.epoch) || this.mutation !== operation.token) return false;
    this.mutation = null;
    return true;
  }
  beginDrop(): number | null {
    if (this.dropEpoch !== null) return null;
    this.dropEpoch = this.epoch;
    return this.epoch;
  }
  finishDrop(epoch: number): void {
    if (this.isCurrentEpoch(epoch) && this.dropEpoch === epoch) this.dropEpoch = null;
  }
  get dropInFlight(): boolean {
    return this.dropEpoch !== null;
  }
  get mutationInFlight(): boolean {
    return this.mutation !== null;
  }
}
