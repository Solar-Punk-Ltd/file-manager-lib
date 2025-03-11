type Listener<T = any> = (data: T) => void;

interface Events {
  [key: string]: Listener<any>[];
}

export class EventEmitter {
  private events: Events = {};

  constructor() {
    this.on = this.on.bind(this);
    this.off = this.off.bind(this);
    this.cleanAll = this.cleanAll.bind(this);
    this.emit = this.emit.bind(this);
  }

  public on<T = any>(event: string, listener: Listener<T>): void {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
  }

  public off<T = any>(event: string, listener: Listener<T>): void {
    if (!this.events[event]) return;
    const index = this.events[event].indexOf(listener);
    if (index > -1) {
      this.events[event].splice(index, 1);
    }
  }

  public cleanAll(): void {
    this.events = {};
  }

  public emit<T = any>(event: string, data: T): void {
    if (!this.events[event]) return;
    this.events[event].forEach((listener) => listener(data));
  }
}
