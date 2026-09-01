export class InFlightLimiter {
  private active = 0;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('IN_FLIGHT_LIMIT_INVALID');
  }

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
  }

  get activeCount(): number {
    return this.active;
  }
}

export const isGenerationPath = (path: string): boolean => /^(?:\/api)?\/v1\/generate(?:\/batch)?$/u.test(path);
