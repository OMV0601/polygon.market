import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTemperatureMarket,
  parseBucketMarket,
  groupIntoEvents,
} from '../../src/strategies/weather/parsers/BucketMarketParser';

// Titles taken verbatim from a live Polymarket market list.
const NOW = new Date('2026-08-17T12:00:00Z');

test('parses a Celsius integer bucket', () => {
  const p = parseBucketMarket('s', 'Will the highest temperature in Hong Kong be 30°C on August 18?', NOW);
  assert.ok(p);
  assert.equal(p.city, 'Hong Kong');
  assert.equal(p.unit, 'C');
  assert.equal(p.kind, 'RANGE');
  // Resolution rounds to a whole degree, so 30 covers [29.5, 30.5).
  assert.equal(p.lowerEdge, 29.5);
  assert.equal(p.upperEdge, 30.5);
  assert.equal(p.targetDate.toISOString().slice(0, 10), '2026-08-18');
});

test('parses a Fahrenheit range bucket', () => {
  const p = parseBucketMarket(
    's',
    'Will the highest temperature in Los Angeles be between 74-75°F on August 17?',
    NOW
  );
  assert.ok(p);
  assert.equal(p.city, 'Los Angeles');
  assert.equal(p.unit, 'F');
  assert.equal(p.lowerEdge, 73.5);
  assert.equal(p.upperEdge, 75.5);
});

test('strips a parenthetical city qualifier for geocoding', () => {
  const p = parseBucketMarket('s', 'Will the highest temperature in Seoul (Incheon) be 28°C on August 18?', NOW);
  assert.ok(p);
  assert.equal(p.city, 'Seoul');
});

test('catch-all buckets become open-ended intervals', () => {
  const above = parseBucketMarket('s', 'Will the highest temperature in Tokyo be 35°C or above on August 18?', NOW);
  assert.ok(above);
  assert.equal(above.kind, 'AT_OR_ABOVE');
  assert.equal(above.lowerEdge, 34.5);
  assert.equal(above.upperEdge, Infinity);

  const below = parseBucketMarket('s', 'Will the highest temperature in Munich be 15°C or below on August 18?', NOW);
  assert.ok(below);
  assert.equal(below.kind, 'AT_OR_BELOW');
  assert.equal(below.lowerEdge, -Infinity);
  assert.equal(below.upperEdge, 15.5);
});

test('rejects non-temperature markets that mention highs', () => {
  // This one slipped through an earlier regex that keyed on the bare word "high".
  assert.equal(parseBucketMarket('s', 'Will WTI Crude Oil (WTI) hit (HIGH) $90 in August?', NOW), null);
  assert.equal(isTemperatureMarket('Bitcoin Up or Down on August 18?'), false);
});

test('picks the year nearest now when the title omits it', () => {
  // Seen on Jan 2, a "December 31" market belongs to the year just ended.
  const p = parseBucketMarket(
    's',
    'Will the highest temperature in Sydney be 30°C on December 31?',
    new Date('2027-01-02T00:00:00Z')
  );
  assert.ok(p);
  assert.equal(p.targetDate.toISOString().slice(0, 10), '2026-12-31');
});

test('groups buckets of one city and date into a single event', () => {
  const titles = [
    'Will the highest temperature in Hong Kong be 29°C on August 18?',
    'Will the highest temperature in Hong Kong be 30°C on August 18?',
    'Will the highest temperature in Hong Kong be 31°C on August 18?',
    'Will the highest temperature in Hong Kong be 30°C on August 19?',
    'Will the highest temperature in Tokyo be 30°C on August 18?',
  ];

  const parsed = titles
    .map((t, i) => ({ parsed: parseBucketMarket(`s${i}`, t, NOW)! }))
    .filter((x) => x.parsed);

  assert.equal(parsed.length, 5);

  const events = groupIntoEvents(parsed);
  assert.equal(events.size, 3);

  const hkAug18 = [...events.entries()].find(([k]) => k.startsWith('Hong Kong|2026-08-18'));
  assert.ok(hkAug18);
  assert.equal(hkAug18[1].length, 3);
});
