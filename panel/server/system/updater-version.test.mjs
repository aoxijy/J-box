import assert from 'node:assert/strict'
import test from 'node:test'
import { compareVersions } from './updater.mjs'

test('firmware commit hash is treated as an unknown older version than a published release', () => {
  assert.ok(compareVersions('v0.1.200', 'e1c526d') > 0)
  assert.equal(compareVersions('e1c526d', 'v0.1.200'), -1)
})

test('recognized release versions retain semver ordering and same-release behavior', () => {
  assert.ok(compareVersions('v0.1.201', 'v0.1.200') > 0)
  assert.equal(compareVersions('v0.1.200', 'v0.1.200'), 0)
  assert.equal(compareVersions('v0.1.200', 'v0.1.200-12-gabcdef0'), 0)
  assert.equal(compareVersions('not-a-release', 'also-not-a-release'), 0)
  assert.equal(compareVersions('not-a-release', 'v0.1.200'), -1)
  assert.equal(compareVersions('v0.1.200', 'not-a-release'), 1)
})
