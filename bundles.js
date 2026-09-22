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
// `folders` says which service a channel plays from, by the prefix the
// reseller puts on its category - "Strong8K: US| FOX NETWORK" is Strong.
// The dashboard's "best tested" button takes up to `bestPerFolder` from
// each, so a network ends up with links on both services and one of them
// having a bad night leaves the other half of the list working.
const BUNDLES = [
  {
    key: 'flix-streams',
    label: 'Flix-Streams',
    testsAtOnce: 2,
    maxTestsAtOnce: 3,
    testSeconds: 10,
    folders: [
      { prefix: 'Strong8K', label: 'Strong' },
      { prefix: 'Trex', label: 'Trex' },
    ],
    bestPerFolder: 5,
  },
];

const BUNDLE_BY_KEY = new Map(BUNDLES.map(bundle => [bundle.key, bundle]));

function bundleFor(key) {
  return BUNDLE_BY_KEY.get(String(key || '')) || null;
}

module.exports = {
  BUNDLES,
  bundleFor,
};
