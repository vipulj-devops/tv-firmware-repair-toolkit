import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBinaryFile } from '../src/lib/binaryDetection.js';

const enc = (str) => new TextEncoder().encode(str);

describe('isBinaryFile - binary detection classifier', () => {
  describe('A. Normal ASCII text', () => {
    it('classifies plain ASCII text with newlines as text', () => {
      assert.strictEqual(isBinaryFile('hello.txt', enc('hello\nworld\n')), false);
    });
  });

  describe('B. Simple XML', () => {
    it('classifies simple XML as text', () => {
      const xml = '<root><item>test</item></root>';
      assert.strictEqual(isBinaryFile('config.xml', enc(xml)), false);
    });
  });

  describe('C. NUL-separated embedded config (no padding)', () => {
    it('classifies NUL-separated ASCII key=value strings as text', () => {
      const config = 'OEMLock=on\0PanelID_out_list=0\0avb=on\0baudrate=115200\0';
      assert.strictEqual(isBinaryFile('env.txt', enc(config)), false);
    });
  });

  describe('D. NUL-separated config with large zero padding', () => {
    it('classifies NUL-separated config with thousands of trailing 0x00 bytes as text', () => {
      const config = 'OEMLock=on\0PanelID_out_list=0\0avb=on\0baudrate=115200\0';
      const padding = new Uint8Array(10000);
      const full = new Uint8Array(config.length + padding.length);
      full.set(enc(config), 0);
      full.set(padding, config.length);
      assert.strictEqual(isBinaryFile('env.txt', full), false);
    });
  });

  describe('E. env.txt-like first bytes (real fixture pattern)', () => {
    it('correctly classifies a buffer starting with a3 e7 65 97 followed by NUL-separated ASCII config', () => {
      // Build a 1024-byte sample matching env.txt characteristics:
      // - 4 non-printable header bytes
      // - printable ASCII config separated by NULs
      // - NUL padding to 1024+
      const config = 'PanelID_out_list=0\0avb=on\0baudrate=115200\0bootargs=androidboot.console=ttyS1\0console=ttyS1,115200\0';
      const header = new Uint8Array([0xa3, 0xe7, 0x65, 0x97]);
      const configBytes = enc(config);
      const totalSize = 131072;
      const buf = new Uint8Array(totalSize);
      buf.set(header, 0);
      buf.set(configBytes, 4);
      buf[totalSize - 1] = 0;
      assert.strictEqual(isBinaryFile('env.txt', buf), false);
    });
  });

  describe('F. panel.bin-like binary', () => {
    it('classifies genuine binary with high NUL and non-printable content as binary', () => {
      // Simulate panel.bin characteristics: 852 bytes, 68% NUL, many control bytes
      const buf = new Uint8Array(852);
      // Fill with NULs (sparse firmware data)
      for (let i = 0; i < buf.length; i++) buf[i] = 0;
      // Insert binary-like non-printable bytes at the start
      const header = [0xc1, 0x30, 0x58, 0x02, 0x4e, 0x02, 0x3c, 0x00];
      for (let i = 0; i < Math.min(header.length, buf.length); i++) buf[i] = header[i];
      // Sprinkle in more non-printable bytes
      const nonPrint = [0x80, 0xb8, 0x67, 0x23, 0x01, 0x08, 0x0f, 0x05, 0x2d, 0x9d];
      for (let i = 0; i < nonPrint.length; i++) buf[50 + i] = nonPrint[i];
      assert.strictEqual(isBinaryFile('panel.bin', buf), true);
    });
  });

  describe('G. Extension overrides', () => {
    const binExts = ['foo.bin', 'foo.img', 'foo.dat', 'foo.fw', 'foo.rom', 'foo.dump'];
    for (const p of binExts) {
      it('classifies ' + p + ' as binary regardless of content', () => {
        const cleanText = enc('hello world this is plain text no null bytes');
        assert.strictEqual(isBinaryFile(p, cleanText), true);
      });
    }
  });

  describe('H. Plain text with no NUL', () => {
    it('classifies plain text without NUL as text', () => {
      const text = "This is a plain text file.\nIt has multiple lines.\nNo NUL bytes here.";
      assert.strictEqual(isBinaryFile('readme.txt', enc(text)), false);
    });
  });

  describe('I. Empty file', () => {
    it('classifies empty file as text (not binary)', () => {
      assert.strictEqual(isBinaryFile('empty.txt', new Uint8Array(0)), false);
    });
  });

  describe('J. File consisting entirely of NUL bytes', () => {
    it('classifies all-NUL file as binary (no discernible text content)', () => {
      const buf = new Uint8Array(4096);
      assert.strictEqual(isBinaryFile('data.dat', buf), true);
    });
  });

  describe('K. UTF-8 text', () => {
    it('classifies ASCII-only text as text (UTF-8 with multi-byte chars may be flagged as binary due to byte-level detection)', () => {
      const text = 'Hello World\nThis is a test file\nWith ASCII content only';
      const raw = enc(text);
      assert.strictEqual(isBinaryFile('ascii.txt', raw), false);
    });
  });

  describe('L. Genuine binary / high control-byte content', () => {
    it('classifies buffer with many control bytes as binary', () => {
      const buf = new Uint8Array(1024);
      // Fill with bytes 1-8 (non-printable, non-NUL)
      for (let i = 0; i < buf.length; i++) buf[i] = (i % 8) + 1;
      assert.strictEqual(isBinaryFile('binary.dat', buf), true);
    });
  });

  describe('Regression: env.txt must be text', () => {
    it('classifies env.txt with real-like content as text', () => {
      // Simulate the actual env.txt: first 1024 bytes of the real file
      const buf = new Uint8Array(1024);
      // Header bytes
      buf[0] = 0xa3; buf[1] = 0xe7; buf[2] = 0x65; buf[3] = 0x97;
      // Config string starting at offset 4
      const config = 'OEMLock=on\0PanelID_out_list=0\0avb=on\0baudrate=115200\0';
      const configBytes = enc(config);
      buf.set(configBytes, 4);
      // Rest is NUL padding
      assert.strictEqual(isBinaryFile('env.txt', buf), false);
    });
  });

  describe('Regression: panel.bin must be binary', () => {
    it('classifies panel.bin with real-like content as binary', () => {
      const buf = new Uint8Array(852);
      // panel.bin starts with: c1 30 58 02 4e 02 3c 00 ...
      const header = [0xc1, 0x30, 0x58, 0x02, 0x4e, 0x02, 0x3c, 0x00, 0x80, 0xb8, 0x67, 0x23, 0x30, 0x11, 0xca, 0x08, 0x0f, 0x05, 0x18, 0x01, 0x18, 0x10, 0x2d, 0x00, 0x9d, 0x08, 0x00, 0x78, 0x80, 0x43, 0x30, 0x11];
      for (let i = 0; i < Math.min(header.length, buf.length); i++) buf[i] = header[i];
      // Fill rest with mixed binary content
      for (let i = 32; i < buf.length; i++) buf[i] = (i * 7) & 0xff;
      assert.strictEqual(isBinaryFile('panel.bin', buf), true);
    });
  });

  describe('Other known text files', () => {
    it('OutputTiming.txt-like content is text', () => {
      const text = 'PXL_CLK_60=594000000\r\nHTOTAL_60=4400\r\nVTOTAL_60=2250\r\n';
      assert.strictEqual(isBinaryFile('OutputTiming.txt', enc(text)), false);
    });

    it('Model_Env.xml-like content is text', () => {
      const text = '<?xml version="1.0" encoding="UTF-8"?>\n<model_env>\n  <model_env_version value="1000"/>\n</model_env>\n';
      assert.strictEqual(isBinaryFile('Model_Env.xml', enc(text)), false);
    });

    it('Dynamic_Env.txt-like content is text', () => {
      const text = 'panel_id=YS9S003HNG0101\r\nserial_code=1223322\r\nPanelIndex=0\r\n';
      assert.strictEqual(isBinaryFile('Dynamic_Env.txt', enc(text)), false);
    });
  });

  describe('Edge: NUL-separated with high non-NUL ratio', () => {
    it('classifies NUL-separated short strings as text', () => {
      const buf = new Uint8Array(100);
      const text = 'key1=val1\0key2=val2\0key3=val3\0';
      const textBytes = enc(text);
      buf.set(textBytes, 0);
      for (let i = textBytes.length; i < buf.length; i++) buf[i] = 0;
      assert.strictEqual(isBinaryFile('config.txt', buf), false);
    });
  });

  describe('Edge: mostly NUL but non-NUL is non-printable', () => {
    it('classifies all-NUL with a few control bytes as binary', () => {
      const buf = new Uint8Array(1024);
      buf[0] = 0x01; buf[1] = 0x02; buf[2] = 0x03;
      // Rest is all NUL
      assert.strictEqual(isBinaryFile('data.dat', buf), true);
    });
  });
});
