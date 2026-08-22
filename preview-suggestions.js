// Throwaway. Shows what the suggestion engine would propose for every
// network, from your actual playlist. This is what the portal's picker
// will pre-fill before you override anything.
//
// Usage: node preview-suggestions.js "<playlist URL>"
//    or: put the URL in playlist-url.txt and run: node preview-suggestions.js

const fs = require('fs');

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'axios') return 'axios-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['axios-stub'] = {
  id: 'axios-stub', filename: 'axios-stub', loaded: true,
  exports: { get: () => { throw new Error('unused'); } }
};

const m3u = require('./m3u.js');
const net = require('./networks.js');

async function main() {
  let url = process.argv[2];
  if (!url && fs.existsSync('playlist-url.txt')) url = fs.readFileSync('playlist-url.txt', 'utf8').trim();
  if (!url) { console.error('No playlist URL given.'); process.exit(1); }

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
  const { channels } = m3u.parseM3UPlaylist(await res.text());
  console.log(`Parsed ${channels.length} channels.\n`);

  const suggestions = net.suggestAllNetworks(channels);
  let empty = [];

  for (const network of net.NETWORKS) {
    const list = suggestions[network.key];
    if (!list.length) { empty.push(network.label); continue; }
    console.log(`${network.label}  (${network.kind})`);
    list.forEach((s, i) => {
      const id = s.url.split('/').pop();
      console.log(`   ${i + 1}. [score ${String(s.score).padStart(3)}] ${s.name}`);
      console.log(`      tvg-id: ${s.tvgId}   stream: ...${id}`);
      console.log(`      groups: ${s.groups.join(' | ')}`);
    });
    console.log('');
  }

  if (empty.length) {
    console.log(`NO SUGGESTIONS FOUND FOR: ${empty.join(', ')}`);
    console.log('(these would need to be picked manually via search)');
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
