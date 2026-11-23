'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSysInfoIntent, getSysInfo } = require('../src/core/sysinfo');

const topics = (q) => [...(parseSysInfoIntent(q) || [])].sort().join(',');

test('sysinfo: intent is detected in en/pt/es and general questions are left alone', () => {
  assert.equal(topics('quanta memória RAM eu tenho?'), 'ram');
  assert.equal(topics('qual o nome do pc?'), 'host');
  assert.equal(topics('what is my graphics card?'), 'gpu');
  assert.equal(topics('modelo do meu mac'), 'model');
  assert.equal(topics('qual o mac address?'), 'mac');
  assert.equal(topics('what is a GPU?'), '');
  assert.equal(topics('explique o que é RAM'), '');
});

test('sysinfo: getSysInfo returns the basics on any OS', async () => {
  const i = await getSysInfo(new Set(['ram', 'host']));
  assert.ok(i.host && i.ramTotal > 0 && i.ramFree > 0 && i.os);
});

test('sysinfo: wmic /value output is parsed (Windows plan B when PowerShell is unavailable)', () => {
  const { parseWmic } = require('../src/core/sysinfo');
  const out = '\r\r\nDeviceID=C:\r\nFreeSpace=1000\r\nSize=5000\r\nVolumeName=Windows\r\n\r\n\r\nDeviceID=D:\r\nFreeSpace=10\r\nSize=50\r\nVolumeName=\r\n\r\n';
  assert.deepEqual(parseWmic(out), [
    { DeviceID: 'C:', FreeSpace: '1000', Size: '5000', VolumeName: 'Windows' },
    { DeviceID: 'D:', FreeSpace: '10', Size: '50', VolumeName: '' },
  ]);
});
