import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const emmcToolSrc = readFileSync(join(dir, '../src/pages/EmmcTool.jsx'), 'utf8');
const partitionTableSrc = readFileSync(join(dir, '../src/components/emmc/PartitionTable.jsx'), 'utf8');

describe('EMMC UI State Preservation — Source & Behavioral Contracts', () => {
  describe('1. PartitionTable controlled filters & container ref', () => {
    it('PartitionTable accepts filters, onFilterChange, and containerRef props', () => {
      assert.match(partitionTableSrc, /filters/);
      assert.match(partitionTableSrc, /onFilterChange/);
      assert.match(partitionTableSrc, /containerRef/);
    });

    it('PartitionTable attaches ref={containerRef} to the scrollable table container', () => {
      assert.match(partitionTableSrc, /<div\s+ref=\{containerRef\}\s+className="flex-1 min-h-0 overflow-x-auto overflow-y-auto"/);
    });

    it('PartitionTable uses controlled filter values and calls updateFilter / clearFilters', () => {
      assert.match(partitionTableSrc, /const query = filters \? filters\.query : '';/);
      assert.match(partitionTableSrc, /const typeFilter = filters \? filters\.typeFilter : '';/);
      assert.match(partitionTableSrc, /const fsFilter = filters \? filters\.fsFilter : '';/);
      assert.match(partitionTableSrc, /updateFilter\('query', e\.target\.value\)/);
      assert.match(partitionTableSrc, /updateFilter\('typeFilter', e\.target\.value\)/);
      assert.match(partitionTableSrc, /updateFilter\('fsFilter', e\.target\.value\)/);
      assert.match(partitionTableSrc, /clearFilters/);
    });

    it('PartitionTable does NOT hold internal useState/useEffect for filter state', () => {
      assert.equal(/const \[query, setQuery\] = useState/.test(partitionTableSrc), false);
      assert.equal(/const \[typeFilter, setTypeFilter\] = useState/.test(partitionTableSrc), false);
      assert.equal(/const \[fsFilter, setFsFilter\] = useState/.test(partitionTableSrc), false);
    });
  });

  describe('2. EmmcTool UI state ownership', () => {
    it('EmmcTool owns partitionFilters state, tableContainerRef, and savedScrollRef', () => {
      assert.match(emmcToolSrc, /const \[partitionFilters, setPartitionFilters\] = useState\(\{ query: '', typeFilter: '', fsFilter: '' \}\);/);
      assert.match(emmcToolSrc, /const tableContainerRef = useRef\(null\);/);
      assert.match(emmcToolSrc, /const savedScrollRef = useRef\(null\);/);
    });

    it('EmmcTool passes controlled props to PartitionTable', () => {
      assert.match(emmcToolSrc, /<PartitionTable[\s\S]*?filters=\{partitionFilters\}/);
      assert.match(emmcToolSrc, /<PartitionTable[\s\S]*?onFilterChange=\{setPartitionFilters\}/);
      assert.match(emmcToolSrc, /<PartitionTable[\s\S]*?containerRef=\{tableContainerRef\}/);
    });
  });

  describe('3. Save UI state before Explore', () => {
    it('explore(p) captures window scroll and table container scrollTop/scrollLeft into savedScrollRef', () => {
      assert.match(emmcToolSrc, /savedScrollRef\.current = \{/);
      assert.match(emmcToolSrc, /main:\s*typeof window !== 'undefined' \? \(window\.scrollY \|\| document\.documentElement\?\.scrollTop \|\| 0\) : 0/);
      assert.match(emmcToolSrc, /tableTop:\s*tableContainerRef\.current \? tableContainerRef\.current\.scrollTop : 0/);
      assert.match(emmcToolSrc, /tableLeft:\s*tableContainerRef\.current \? tableContainerRef\.current\.scrollLeft : 0/);
    });

    it('savedScrollRef is populated BEFORE setting explorePart', () => {
      const explorePos = emmcToolSrc.indexOf('const explore = async');
      const capturePos = emmcToolSrc.indexOf('savedScrollRef.current = {', explorePos);
      const setPartPos = emmcToolSrc.indexOf('setExplorePart(p)', explorePos);
      assert.ok(explorePos !== -1);
      assert.ok(capturePos !== -1);
      assert.ok(setPartPos !== -1);
      assert.ok(capturePos < setPartPos, 'Scroll state capture must occur before setting explorePart');
    });
  });

  describe('4. Restore UI state on return from Explore', () => {
    it('EmmcTool restores main scroll and table scroll position via useLayoutEffect', () => {
      assert.match(emmcToolSrc, /useLayoutEffect\(\(\) => \{/);
      assert.match(emmcToolSrc, /if \(!explorePart && savedScrollRef\.current\)/);
      assert.match(emmcToolSrc, /window\.scrollTo\(0, saved\.main\)/);
      assert.match(emmcToolSrc, /tableContainerRef\.current\.scrollTop = saved\.tableTop/);
      assert.match(emmcToolSrc, /tableContainerRef\.current\.scrollLeft = saved\.tableLeft/);
    });

    it('useLayoutEffect clears savedScrollRef to prevent infinite restoration loops', () => {
      assert.match(emmcToolSrc, /savedScrollRef\.current = null;/);
    });

    it('includes requestAnimationFrame backup for layout timing safety', () => {
      assert.match(emmcToolSrc, /requestAnimationFrame\(restore\)/);
    });
  });

  describe('5. Reset state on new dump or start over', () => {
    it('loadMain resets partitionFilters and clears savedScrollRef', () => {
      const loadMainPos = emmcToolSrc.indexOf('const loadMain = async');
      const resetFiltersPos = emmcToolSrc.indexOf("setPartitionFilters({ query: '', typeFilter: '', fsFilter: '' })", loadMainPos);
      const resetScrollPos = emmcToolSrc.indexOf('savedScrollRef.current = null', loadMainPos);
      assert.ok(loadMainPos !== -1);
      assert.ok(resetFiltersPos !== -1);
      assert.ok(resetScrollPos !== -1);
    });

    it('resetToStart resets partitionFilters and clears savedScrollRef', () => {
      const resetStartPos = emmcToolSrc.indexOf('const resetToStart = () =>');
      const resetFiltersPos = emmcToolSrc.indexOf("setPartitionFilters({ query: '', typeFilter: '', fsFilter: '' })", resetStartPos);
      const resetScrollPos = emmcToolSrc.indexOf('savedScrollRef.current = null', resetStartPos);
      assert.ok(resetStartPos !== -1);
      assert.ok(resetFiltersPos !== -1);
      assert.ok(resetScrollPos !== -1);
    });
  });

  describe('6. Regression & Safety checks', () => {
    it('Explore navigation handlers (setExplorePart(null), etc.) remain intact', () => {
      assert.match(emmcToolSrc, /aria-label="Back to partition table"/);
      assert.match(emmcToolSrc, /setExplorePart\(null\)/);
      assert.match(emmcToolSrc, /setExploreBytes\(null\)/);
      assert.match(emmcToolSrc, /setExploreReader\(null\)/);
    });

    it('Dump compose and partition blob methods remain untouched', () => {
      assert.match(emmcToolSrc, /const buildOutputBlob = \(\) => composeDumpBlob/);
      assert.match(emmcToolSrc, /const getPartitionBlob = \(p\) => composePartitionBlob/);
    });

    it('Does not introduce localStorage, sessionStorage, or global state', () => {
      assert.equal(emmcToolSrc.includes('localStorage'), false);
      assert.equal(emmcToolSrc.includes('sessionStorage'), false);
      assert.equal(partitionTableSrc.includes('localStorage'), false);
      assert.equal(partitionTableSrc.includes('sessionStorage'), false);
    });
  });
});
