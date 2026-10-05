export class RisingEdgeDetector {
    private previous?: boolean;
    constructor(private readonly acceptInitialTrue = false) {}
    update(current: boolean): boolean {
        if (this.previous === undefined) {
            this.previous = current;
            return current && this.acceptInitialTrue;
        }
        const rising = !this.previous && current;
        this.previous = current;
        return rising;
    }
    reset(): void { this.previous = undefined; }
}
