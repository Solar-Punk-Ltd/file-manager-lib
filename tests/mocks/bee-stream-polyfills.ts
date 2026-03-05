// tests/mocks/bee-stream-polyfill.ts
import { Bee } from '@ethersphere/bee-js';

// streamFiles throws in the CJS/Node build.
// In browser tests, replace it with uploadFiles so the browser
// upload path can be exercised end-to-end without a real browser runtime.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
Bee.prototype.streamFiles = async function (batchId, files, _onProgress, options, requestOptions) {
  return this.uploadFiles(batchId, files, options, requestOptions);
};
