const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const config = JSON.parse(fs.readFileSync(process.env.T3_SHARED_CODEX_CONFIG || path.join(__dirname,'config.json'),'utf8'));
const args = process.argv.slice(2);
if (!args.includes('app-server')) {
  const child = spawn(config.binary,args,{stdio:'inherit',windowsHide:true});
  child.on('error',e=>{console.error(e.message);process.exit(1)});
  child.on('exit',code=>process.exit(code??1));
} else {
  if (process.env.CODEX_HOME && path.resolve(process.env.CODEX_HOME).toLowerCase() !== path.resolve(config.home).toLowerCase()) {
    console.error('Shared Codex home does not match this provider. Use a separate provider for another home.'); process.exit(1);
  }
  let closed=false, queue=[];
  const ws = new WebSocket(config.url);
  const rl = require('node:readline').createInterface({input:process.stdin});
  const timer = setTimeout(()=>finish(1,'Shared Codex connection timed out. Run Start-Shared-Codex.cmd.'),10000);
  function finish(code,message) { if(closed)return;closed=true;clearTimeout(timer);if(message)console.error(message);rl.close();process.stdin.destroy();ws.close();process.exitCode=code;setTimeout(()=>process.exit(code),50); }
  rl.on('line',line=>{if(closed)return;if(ws.readyState===1)ws.send(line);else if(queue.length<100)queue.push(line);else finish(1,'Shared Codex connection queue full.');});
  ws.addEventListener('open',()=>{clearTimeout(timer);for(const line of queue)ws.send(line);queue=[];});
  ws.addEventListener('message',event=>process.stdout.write(event.data+'\n'));
  ws.addEventListener('error',()=>finish(1,'Shared Codex unavailable. Run Start-Shared-Codex.cmd.'));
  ws.addEventListener('close',()=>finish(1,'Shared Codex disconnected; pending requests were not replayed.'));
  process.stdin.on('end',()=>finish(0));
  process.on('SIGTERM',()=>finish(0));process.on('SIGINT',()=>finish(0));
}
