// IPTV services that resell other services under one login.
//
// Flix-Streams sells Strong and Trex together, every category listed
// twice - "Strong8K: US| FOX NETWORK" and "Trex: US| FOX NETWORK" - and
// each folder really does play from the service it names. What it does
// not keep is the upstream stream ids: every channel is renumbered, and
// the new ids bear no relation to the old ones. So streamcheck.pro's
// published sweeps, keyed by the upstream id, describe none of these
// channels.
//
// Matching them by name was tried and taken out again. It read Trex's
// copies well, but a Strong copy could only be tied to a station, not to
// a feed - Strong carries several feeds of most stations - and the badge
// it produced for FOX 28 Cedar Rapids said 1080p60 for a channel that
// plays at 720p60. A reseller's channels are measured by ffprobe
// instead, when somebody asks. See probe.js.
//
// Marking a provider as a reseller means two things now, both decided in
// server.js: testing is the ONLY reading its channels have, and auto-pick
// leaves its links alone, because it has nothing trustworthy to pick
// with. It used to mean a third - that its channels were the only ones
// that could be tested at all - and that is no longer a reseller's
// privilege. Every provider can be tested from a network section; what
// makes this one different is that there is nothing else to compare the
// answer against.

// One entry per reseller. Adding another is an entry here and nothing
// else.
//
// `maxTestsAtOnce` is how many connections the service sells on one
// login, and `testsAtOnce` how many of them a test run takes when
// nobody has said otherwise. Flix-Streams sells three; two is the
// default because it leaves one, so somebody can go on watching while a
// run is under way, and taking all three would make every run a reason
// the stream they are watching drops.
//
// The default is a default and not a rule. Somebody with nobody else
// watching wants the third connection and a run that finishes half as
// fast again; somebody sharing the login wants one. Both set it on the
// provider, the same field and the same dropdown an ordinary provider
// uses - what the reseller entry decides is the ceiling that dropdown
// stops at, because the number of connections sold IS a fact about the
// service and the same for everybody who buys it. See testLimitsFor in
// server.js, which is where the two meet.
//
// `testSeconds` is how much of a stream a test reads. Ten rather than the
// default twenty: resolution and frame rate - which decide whether a
// channel passes - are read in the first few seconds either way, and the
// longer window only steadies the bitrate. Halving it roughly halves a
// run, at the price of a noisier bpp, which can swap two channels that
// sit close together inside a band but cannot move one across the pass
// line.
//
// Flix-Streams used to be one login carrying Strong and Trex, told apart
// by the prefix on each category. It is now three logins - Dream, Strong
// and Trex - on one server and one password, the username differing by a
// suffix: "name.dream", "name.strong", "name.trex". Each is added as its
// own provider, and the three share ONE allowance of connections, not
// three. A test run that counted each provider's three separately was
// fine inside the first provider and ran past the limit the moment it
// moved to the next, with the first one's probes still open.
//
// `loginSuffixes` are what come off a username to find the login they
// all share (see sharedLoginName), so the probe lane that holds a run to
// `testsAtOnce` is the same lane for all three. Because the allowance is
// the login's and not any one provider's, `testsAtOnce` is not a
// per-provider setting for a reseller: it is the number here, three,
// which is every connection the login has. Somebody who wants one left
// free to watch with can lower it here.
//
// The dashboard's "best tested" button takes up to `bestPerProvider` from
// each provider and deals them out one provider at a time - each one's
// best in slots 1-3, each one's second best in 4-6 - so the first slots
// span all three services and one of them having a bad night leaves the
// others playing.
const BUNDLES = [
  {
    key: 'flix-streams',
    label: 'Flix-Streams',
    testsAtOnce: 3,
    maxTestsAtOnce: 3,
    testSeconds: 10,
    loginSuffixes: ['dream', 'strong', 'trex'],
    bestPerProvider: 5,
  },
];

const BUNDLE_BY_KEY = new Map(BUNDLES.map(bundle => [bundle.key, bundle]));

function bundleFor(key) {
  return BUNDLE_BY_KEY.get(String(key || '')) || null;
}

// The username with the bundle's service suffix taken off, so
// "name.strong" and "name.trex" come out as the same login. A username
// ending in anything else is left alone.
function sharedLoginName(bundle, username) {
  const name = String(username || '');
  for (const suffix of (bundle && bundle.loginSuffixes) || []) {
    const tail = `.${suffix}`;
    if (name.toLowerCase().endsWith(tail)) return name.slice(0, -tail.length);
  }
  return name;
}

module.exports = {
  BUNDLES,
  bundleFor,
  sharedLoginName,
};
