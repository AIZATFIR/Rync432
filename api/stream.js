import { handleStreamProxy } from '../server/streaming/proxyStream.js';

export const config = {
  api: {
    responseLimit: false
  }
};

export default async function handler(req, res) {
  return handleStreamProxy(req, res);
}
