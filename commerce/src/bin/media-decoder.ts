// No application/database/storage credentials and no egress network in the decoder container.
import { rmSync } from 'node:fs';
import { createDecoderServer } from '../media/decoder-server.js';
if (process.platform !== 'linux') throw new Error('MEDIA_LINUX_REQUIRED');
for (const [key, value] of Object.entries(process.env)) {
  if (value && /(?:DATABASE_URL|SECRET|ACCESS_KEY|TOKEN|PASSWORD|TOTP|AUDIT_KEY)/.test(key))
    throw new Error('DECODER_FOREIGN_CREDENTIAL');
}
const socket = '/run/media-decoder/decode.sock';
process.umask(0o077);
rmSync(socket, { force: true });
const server = createDecoderServer();
server.listen(socket);
process.once('SIGTERM', () => {
  server.close();
});
process.once('SIGINT', () => {
  server.close();
});
