import EventEmitter from "events";

class ReadStream extends EventEmitter {
  isTTY = false;
  setRawMode() {
    return this;
  }
}

class WriteStream extends EventEmitter {
  isTTY = false;
  columns = 80;
  rows = 24;
  getColorDepth = () => 1;
  hasColors = () => false;
  getWindowSize = () => [80, 24];
}

export default { isatty: () => false, ReadStream, WriteStream };
