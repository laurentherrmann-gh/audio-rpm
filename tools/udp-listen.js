// Stand-in for SimHub: listens for DiRT Rally 2.0 packets and prints the decoded rpm once a second.
//   npm run listen                 (port 20777)
//   PORT=20778 npm run listen
import { createSocket } from 'node:dgram';
import { parseDr2Packet } from '../src/dr2-packet.js';

const PORT = Number(process.env.PORT || 20777);
const RPM_DIVISOR = Number(process.env.RPM_DIVISOR || 10);
const sock = createSocket('udp4');
let count = 0, last = null, bytes = 0;

sock.on('message', msg => {
  count++; bytes = msg.length;
  try { last = parseDr2Packet(msg, { rpmDivisor: RPM_DIVISOR }); } catch (e) { console.error(e.message); }
});

setInterval(() => {
  if (!count) { console.log('waiting for packets…'); return; }
  const { rpm, maxRpm, idleRpm, time } = last;
  console.log(`${count} pkt/s  ${bytes} B  rpm ${rpm.toFixed(0).padStart(5)}  (idle ${idleRpm.toFixed(0)}, max ${maxRpm.toFixed(0)})  t=${time.toFixed(1)}s`);
  count = 0;
}, 1000);

sock.bind(PORT, () => console.log(`listening for DR2 packets on udp/${PORT}`));
