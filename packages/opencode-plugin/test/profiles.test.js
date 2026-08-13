import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOdwArguments, routeModel } from '../src/profiles.js';

test('routes balanced, quality and economy roles deterministically', () => {
  assert.equal(routeModel('balanced', 'analysis').model, 'openai/gpt-5.6-luna');
  assert.equal(routeModel('balanced', 'planner').variant, 'max');
  assert.equal(routeModel('quality', 'discovery').variant, 'max');
  assert.equal(routeModel('economy', 'planner').model, 'openai/gpt-5.6-luna');
  assert.equal(routeModel('economy', 'mutation').variant, 'max');
  assert.equal(routeModel('balanced', 'reconstruction').variant, 'max');
});

test('parses one profile flag and defaults to balanced', () => {
  assert.deepEqual(parseOdwArguments('audit this'), { profile: 'balanced', task: 'audit this' });
  assert.deepEqual(parseOdwArguments('--profile quality audit this'), { profile: 'quality', task: 'audit this' });
  assert.deepEqual(parseOdwArguments('audit --profile=economy this'), { profile: 'economy', task: 'audit  this' });
  assert.throws(() => parseOdwArguments('--profile nope audit'), /must be one of/);
  assert.throws(() => parseOdwArguments('--profile quality --profile economy audit'), /only once/);
  assert.throws(() => parseOdwArguments('--profile quality'), /task is required/);
});
