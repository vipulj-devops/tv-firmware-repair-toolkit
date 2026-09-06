import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTextFile, encodeTextFile, crc32_ieee, detectUbootEnv, UBOOT_HEADER_SIZE } from '../src/lib/textDecoding.js';

const enc = (str) => new TextEncoder().encode(str);

function buildUbootEnv(configText, totalSize = 131072) {
  const configBytes = enc(configText);
  const payload = new Uint8Array(totalSize - UBOOT_HEADER_SIZE);
  const contentEnd = Math.min(configBytes.length, totalSize - UBOOT_HEADER_SIZE);
  payload.set(configBytes.subarray(0, contentEnd));
  const crc = crc32_ieee(payload);
  const header = new Uint8Array(UBOOT_HEADER_SIZE);
  header[0] = crc & 0xFF;
  header[1] = (crc >> 8) & 0xFF;
  header[2] = (crc >> 16) & 0xFF;
  header[3] = (crc >> 24) & 0xFF;
  return new Uint8Array([...header, ...payload]);
}

describe('textDecoding', () => {
  describe('crc32_ieee', () => {
    it('computes known CRC32 values', () => {
      assert.strictEqual(crc32_ieee(enc('')), 0);
      assert.strictEqual(crc32_ieee(enc('a')), 0xe8b7be43);
      assert.strictEqual(crc32_ieee(enc('abc')), 0x352441c2);
      assert.strictEqual(crc32_ieee(enc('hello world')), 0x0d4a1185);
    });

    it('matches U-Boot standard CRC32', () => {
      const payload = new Uint8Array(16);
      payload.set(enc('hello'), 0);
      assert.strictEqual(crc32_ieee(payload), 0xbff72c2d);
    });
  });

  describe('detectUbootEnv', () => {
    it('detects a properly formed U-Boot environment', () => {
      const env = buildUbootEnv('OEMLock=on\0PanelID_out_list=0\0avb=on\0', 4096);
      const detected = detectUbootEnv(env);
      assert.ok(detected, 'should detect U-Boot env');
      assert.strictEqual(detected.headerLength, 4);
    });

    it('rejects a file with mismatched CRC', () => {
      const env = buildUbootEnv('OEMLock=on\0avb=on\0', 4096);
      const tampered = new Uint8Array(env);
      tampered[0] ^= 0xFF;
      const detected = detectUbootEnv(tampered);
      assert.strictEqual(detected, null);
    });

    it('rejects a file with valid CRC but non-text content', () => {
      const payload = new Uint8Array(252);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = (i * 7 + 13) & 0xFF;
      }
      const crc = crc32_ieee(payload);
      const raw = new Uint8Array(256);
      raw[0] = crc & 0xFF;
      raw[1] = (crc >> 8) & 0xFF;
      raw[2] = (crc >> 16) & 0xFF;
      raw[3] = (crc >> 24) & 0xFF;
      raw.set(payload, 4);
      assert.strictEqual(detectUbootEnv(raw), null);
    });

    it('rejects a file too small to be a U-Boot env', () => {
      assert.strictEqual(detectUbootEnv(new Uint8Array(0)), null);
      assert.strictEqual(detectUbootEnv(new Uint8Array([1, 2, 3])), null);
      assert.strictEqual(detectUbootEnv(new Uint8Array(8)), null);
    });
  });

  describe('A. Normal ASCII text round trip', () => {
    it('preserves ASCII text exactly', () => {
      const text = 'hello\nworld\n';
      const raw = enc(text);
      const decoded = decodeTextFile(raw, 'test.txt');
      assert.strictEqual(decoded.displayText, text);
      const reencoded = encodeTextFile(decoded.meta, decoded.displayText);
      assert.deepEqual(reencoded, raw);
    });
  });

  describe('B. Normal UTF-8 round trip', () => {
    it('preserves UTF-8 text with Unicode characters', () => {
      const text = 'Hello 世界\nCafé résumé\n日本語テスト';
      const raw = enc(text);
      const decoded = decodeTextFile(raw, 'unicode.txt');
      assert.strictEqual(decoded.displayText, text);
      const reencoded = encodeTextFile(decoded.meta, decoded.displayText);
      assert.deepEqual(reencoded, raw);
    });
  });

  describe('C. NUL-separated text (no CRC header)', () => {
    it('converts NUL separators to newlines for display and restores on encode', () => {
      const text = 'key1=val1\0key2=val2\0key3=val3\0';
      const raw = enc(text);
      const decoded = decodeTextFile(raw, 'config.txt');
      assert.strictEqual(decoded.displayText, 'key1=val1\nkey2=val2\nkey3=val3');
      const reencoded = encodeTextFile(decoded.meta, decoded.displayText);
      assert.deepEqual(reencoded, raw);
    });
  });

  describe('D. NUL-padded text (no CRC header)', () => {
    it('preserves NUL-padded text', () => {
      const content = 'some=content';
      const raw = new Uint8Array(1024);
      raw.set(enc(content), 0);
      const decoded = decodeTextFile(raw, 'padded.txt');
      assert.strictEqual(decoded.displayText, content);
      const reencoded = encodeTextFile(decoded.meta, decoded.displayText);
      assert.deepEqual(reencoded, raw);
    });
  });

  describe('E. env.txt structure and round trip', () => {
    const config = 'OEMLock=on\0PanelID_out_list=0\0avb=on\0baudrate=115200\0bootargs=androidboot.console=ttyS1,115200\0bootargs_ex=no_console_suspend\0bootcmd=bootr\0bootdelay=0\0console=ttyS1,115200\0ethaddr=00:10:20:30:40:50\0gatewayip=192.168.0.1\0ipaddr=192.168.0.200\0loadaddr=0x03000000\0netmask=255.255.255.0\0print=on\0serverip=192.168.0.3\0silent=1\0';
    let envRaw;

    beforeEach(() => {
      envRaw = buildUbootEnv(config, 131072);
    });

    it('detects as U-Boot environment', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      assert.strictEqual(decoded.meta.isUbootEnv, true);
    });

    it('displays clean text without replacement characters', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      assert.ok(!decoded.displayText.includes('\uFFFD'));
      assert.ok(!decoded.displayText.includes('£'));
      assert.ok(!decoded.displayText.includes('ç'));
    });

    it('displays NUL-separated config as newline-separated', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      const lines = decoded.displayText.split('\n');
      assert.strictEqual(lines[0], 'OEMLock=on');
      assert.strictEqual(lines[1], 'PanelID_out_list=0');
      assert.strictEqual(lines[2], 'avb=on');
      assert.strictEqual(lines[3], 'baudrate=115200');
    });

    it('does not include the CRC header in display text', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      assert.ok(!decoded.displayText.startsWith('£'));
      assert.ok(decoded.displayText.startsWith('OEMLock=on') || decoded.displayText.includes('OEMLock=on'));
    });

    it('decode -> encode without editing produces byte-for-byte identical output', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      const reencoded = encodeTextFile(decoded.meta, decoded.displayText);
      assert.deepEqual(reencoded, envRaw);
    });

    it('editing a value produces a valid new CRC', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      const edited = decoded.displayText.replace('OEMLock=on', 'OEMLock=off');
      const reencoded = encodeTextFile(decoded.meta, edited);
      const reDecoded = decodeTextFile(reencoded, 'env.txt');
      assert.strictEqual(reDecoded.meta.isUbootEnv, true);
      assert.strictEqual(reDecoded.meta.header.crc32 !== decoded.meta.header.crc32, true);
      assert.ok(reDecoded.displayText.includes('OEMLock=off'));
    });

    it('editing preserves 128 KiB allocation', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      const edited = decoded.displayText.replace('OEMLock=on', 'OEMLock=off');
      const reencoded = encodeTextFile(decoded.meta, edited);
      assert.strictEqual(reencoded.length, 131072);
    });

    it('editing preserves trailing NUL padding', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      const edited = decoded.displayText.replace('OEMLock=on', 'OEMLock=off');
      const reencoded = encodeTextFile(decoded.meta, edited);
      assert.strictEqual(reencoded[reencoded.length - 1], 0);
      assert.strictEqual(reencoded[131071], 0);
    });

    it('content growth preserves CRC correctness', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      const edited = decoded.displayText + '\nNewVar=42';
      const reencoded = encodeTextFile(decoded.meta, edited);
      const reDecoded = decodeTextFile(reencoded, 'env.txt');
      assert.strictEqual(reDecoded.meta.isUbootEnv, true);
      assert.ok(reDecoded.displayText.includes('NewVar=42'));
    });

    it('rejects oversized edited U-Boot environment content', () => {
      const decoded = decodeTextFile(envRaw, 'env.txt');
      // Construct an oversized payload (> 131068 bytes)
      const oversizedText = 'A'.repeat(131069);
      assert.throws(() => {
        encodeTextFile(decoded.meta, oversizedText);
      }, /exceeds the maximum payload capacity/);
    });
  });

  describe('F. panel.bin remains binary and is unaffected', () => {
    it('panel.bin-like binary is not detected as U-Boot env', () => {
      const buf = new Uint8Array(852);
      buf[0] = 0xc1; buf[1] = 0x30; buf[2] = 0x58; buf[3] = 0x02;
      buf[4] = 0x4e; buf[5] = 0x02; buf[6] = 0x3c; buf[7] = 0x00;
      buf[8] = 0x80; buf[9] = 0xb8; buf[10] = 0x67; buf[11] = 0x23;
      for (let i = 32; i < buf.length; i++) buf[i] = (i * 7) & 0xff;
      assert.strictEqual(detectUbootEnv(buf), null);
    });

    it('panel.bin is not text (isBinaryFile returns true)', async () => {
      const { isBinaryFile } = await import('../src/lib/binaryDetection.js');
      const buf = new Uint8Array(852);
      const header = [0xc1, 0x30, 0x58, 0x02, 0x4e, 0x02, 0x3c, 0x00, 0x80, 0xb8, 0x67, 0x23];
      for (let i = 0; i < header.length; i++) buf[i] = header[i];
      for (let i = 12; i < buf.length; i++) buf[i] = (i * 13) & 0xff;
      assert.strictEqual(isBinaryFile('panel.bin', buf), true);
    });
  });

  describe('G. U-Boot detection requires CRC + text structure', () => {
    it('rejects CRC-matching but non-text payload', () => {
      const payload = new Uint8Array(128);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = (i * 17 + 31) & 0xFF;
      }
      const crc = crc32_ieee(payload);
      const raw = new Uint8Array(132);
      raw[0] = crc & 0xFF;
      raw[1] = (crc >> 8) & 0xFF;
      raw[2] = (crc >> 16) & 0xFF;
      raw[3] = (crc >> 24) & 0xFF;
      raw.set(payload, 4);
      assert.strictEqual(detectUbootEnv(raw), null);
    });
  });

  describe('H. Random binary does not become U-Boot text', () => {
    it('rejects random binary data even with plausible structure', () => {
      const raw = new Uint8Array(1024);
      for (let i = 0; i < raw.length; i++) {
        raw[i] = Math.floor(Math.random() * 256);
      }
      assert.strictEqual(detectUbootEnv(raw), null);
    });

    it('rejects sequential non-text bytes', () => {
      const raw = new Uint8Array(256);
      for (let i = 0; i < raw.length; i++) {
        raw[i] = i;
      }
      assert.strictEqual(detectUbootEnv(raw), null);
    });
  });

  describe('I. Empty file', () => {
    it('handles empty file', () => {
      const decoded = decodeTextFile(new Uint8Array(0), 'empty.txt');
      assert.strictEqual(decoded.displayText, '');
      assert.strictEqual(decoded.meta.isUbootEnv, false);
      assert.deepEqual(encodeTextFile(decoded.meta, ''), new Uint8Array(0));
    });
  });

  describe('J. BOM handling', () => {
    it('strips UTF-8 BOM (standard TextDecoder behavior)', () => {
      const text = '\uFEFFhello\nworld\n';
      const raw = enc(text);
      const decoded = decodeTextFile(raw, 'bom.txt');
      // TextDecoder strips BOM automatically - display text without BOM
      assert.strictEqual(decoded.displayText, 'hello\nworld\n');
      // BOM is not preserved in encode (standard TextDecoder/Encoder behavior)
      // Reencoded text is padded to original size (including BOM bytes as padding)
      const reencoded = encodeTextFile(decoded.meta, decoded.displayText);
      assert.strictEqual(reencoded.length, raw.length);
      assert.strictEqual(Buffer.from(reencoded).toString('utf-8').replace(/\0+$/, ''), 'hello\nworld\n');
    });

    it('BOM file is not detected as U-Boot env', () => {
      const text = '\uFEFFHello World';
      const raw = enc(text);
      const decoded = decodeTextFile(raw, 'test.txt');
      assert.strictEqual(decoded.meta.isUbootEnv, false);
    });
  });

  describe('K. Normal text files remain unchanged', () => {
    it('plain text file behaves as before', () => {
      const text = 'This is a plain text file.\nIt has multiple lines.\nNo NUL bytes here.';
      const raw = enc(text);
      const decoded = decodeTextFile(raw, 'readme.txt');
      assert.strictEqual(decoded.displayText, text);
      assert.strictEqual(decoded.meta.isUbootEnv, false);
      const reencoded = encodeTextFile(decoded.meta, decoded.displayText);
      assert.deepEqual(reencoded, raw);
    });

    it('XML file behaves as before', () => {
      const text = '<?xml version="1.0" encoding="UTF-8"?>\n<root><item>test</item></root>';
      const raw = enc(text);
      const decoded = decodeTextFile(raw, 'config.xml');
      assert.strictEqual(decoded.displayText, text);
      assert.strictEqual(decoded.meta.isUbootEnv, false);
    });

    it('Windows line endings are preserved', () => {
      const text = 'line1\r\nline2\r\nline3';
      const raw = enc(text);
      const decoded = decodeTextFile(raw, 'win.txt');
      assert.strictEqual(decoded.displayText, text);
      const reencoded = encodeTextFile(decoded.meta, decoded.displayText);
      assert.deepEqual(reencoded, raw);
    });
  });

  describe('Real env.txt verification', () => {
    const config =
      'OEMLock=on\0PanelID_out_list=0\0avb=on\0baudrate=115200\0' +
      'bootargs=androidboot.console=ttyS1,115200\0' +
      'bootargs_ex=no_console_suspend\0bootcmd=bootr\0' +
      'bootdelay=0\0console=ttyS1,115200\0ethaddr=00:10:20:30:40:50\0' +
      'gatewayip=192.168.0.1\0ipaddr=192.168.0.200\0loadaddr=0x03000000\0' +
      'netmask=255.255.255.0\0print=on\0serverip=192.168.0.3\0silent=1\0';

    it('first bytes start with CRC, not replacement characters', () => {
      const env = buildUbootEnv(config, 131072);
      const decoded = decodeTextFile(env, 'env.txt');
      // The display text should NOT start with replacement characters or £ç
      assert.ok(!decoded.displayText.startsWith('\uFFFD'));
      assert.ok(!decoded.displayText.startsWith('£'));
      // It should start with readable config text
      assert.ok(decoded.displayText.includes('OEMLock=on'));
    });

    it('shows clean configuration text', () => {
      const env = buildUbootEnv(config, 131072);
      const decoded = decodeTextFile(env, 'env.txt');
      assert.ok(decoded.displayText.indexOf('OEMLock=on') !== -1);
      assert.ok(decoded.displayText.indexOf('PanelID_out_list=0') !== -1);
      assert.ok(decoded.displayText.indexOf('avb=on') !== -1);
      assert.ok(decoded.displayText.indexOf('baudrate=115200') !== -1);
      // No replacement characters
      assert.ok(decoded.displayText.indexOf('\uFFFD') === -1);
    });
  });
});
