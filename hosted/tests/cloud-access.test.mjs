import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudModeEnabled, validateCloudConfig, authorizedBasicHeader, requireCloudAccess } from '../server/cloud-access.mjs';

const secret = 'a-long-private-password-value-12345';
const cloud = { TOUCHLINE_CLOUD_MODE: '1', TOUCHLINE_ACCESS_PASSWORD: secret, TOUCHLINE_DATA_DIR: '/var/data' };

test('cloud auth fails closed on startup when credentials or disk path are missing', () => {
  assert.equal(cloudModeEnabled({}), false);
  assert.equal(cloudModeEnabled(cloud), true);
  assert.doesNotThrow(() => validateCloudConfig({}));
  assert.doesNotThrow(() => validateCloudConfig(cloud));
  assert.throws(() => validateCloudConfig({ ...cloud, TOUCHLINE_ACCESS_PASSWORD: '' }), /PASSWORD/);
  assert.throws(() => validateCloudConfig({ ...cloud, TOUCHLINE_ACCESS_PASSWORD: 'short' }), /PASSWORD/);
  assert.throws(() => validateCloudConfig({ ...cloud, TOUCHLINE_DATA_DIR: 'data' }), /DATA_DIR/);
});

test('auth checks both username and password and denies malformed credentials', () => {
  const good = 'Basic ' + Buffer.from('touchline:' + secret).toString('base64');
  assert.equal(authorizedBasicHeader(good, secret), true);
  assert.equal(authorizedBasicHeader('Basic ' + Buffer.from('other:' + secret).toString('base64'), secret), false);
  assert.equal(authorizedBasicHeader('Basic ' + Buffer.from('touchline:wrong').toString('base64'), secret), false);
  assert.equal(authorizedBasicHeader('Bearer x', secret), false);
  assert.equal(authorizedBasicHeader(undefined, secret), false);
});

test('cloud login blocks all requests before routing; local access is unchanged', () => {
  const response = () => ({
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  });
  const res = response();
  assert.equal(requireCloudAccess({ headers: {} }, res, cloud), true);
  assert.equal(res.status, 401);
  assert.match(res.headers['WWW-Authenticate'], /Basic/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const good = 'Basic ' + Buffer.from('touchline:' + secret).toString('base64');
  assert.equal(requireCloudAccess({ headers: { authorization: good } }, response(), cloud), false);
  assert.equal(requireCloudAccess({ headers: {} }, response(), {}), false);
});
