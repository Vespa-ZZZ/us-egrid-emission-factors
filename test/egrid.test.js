import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DETAILED_DATA, HISTORICAL_DATA, discoverWorkbooks, normalizeInput, parseWorkbook, sanitize } from '../src/egrid.js';
import { runActor } from '../src/run.js';

const fixture = (file) => readFile(new URL('./fixtures/' + file, import.meta.url));
const latestListing = (await fixture('detailed-data.html')).toString('utf8');
const archiveListing = (await fixture('historical-egrid-data.html')).toString('utf8');
const latest = discoverWorkbooks(latestListing, DETAILED_DATA).get(2023);
const archived = discoverWorkbooks(archiveListing, HISTORICAL_DATA).get(2018);
const latestXlsx = await fixture('egrid2023-trimmed.xlsx');
const archivedXlsx = await fixture('egrid2018-trimmed.xlsx');

test('discovers workbook years and highest revisions from official data links', () => {
    const html = latestListing.replace('</main>', `
      <a href="/system/files/documents/2025-01/egrid2023_data_rev1.xlsx">Download eGRID2023 (xlsx)</a>
      <a href="/system/files/documents/2026-07/egrid2024_data.xlsx">Download eGRID2024 (xlsx)</a>
    </main>`);
    const books = discoverWorkbooks(html, DETAILED_DATA);
    assert.deepEqual([...books.keys()], [2023, 2024]);
    assert.equal(books.get(2023).revision, 2);
    assert.equal(books.get(2024).revision, null);
    assert.equal(archived.fileName, 'egrid2018_data_v2.xlsx');
    assert.equal(archived.revision, 2);
    assert.throws(() => discoverWorkbooks('<main>Unexpected layout</main>', DETAILED_DATA), /no eGRID data workbooks/);
    assert.throws(() => discoverWorkbooks(html.replace('with 2023', 'with 2025'), DETAILED_DATA), /advertised eGRID year/);
    assert.throws(() => discoverWorkbooks(html.replace('"/system/files', '"https://example.org/system/files'), DETAILED_DATA),
        /Unrecognized EPA workbook link/);
});

test('keeps the published CO2 and CO2e rates distinct and converts pounds to kilograms', async () => {
    const input = normalizeInput({ subregions: [' camx ', 'NYCW', 'CAMX'] });
    const rows = await parseWorkbook(latestXlsx, input, latest);
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.filter((row) => row.pollutant === 'CO2').map((row) => [row.areaCode, row.value]),
        [['CAMX', 428.464], ['NYCW', 864.469]]);
    assert.deepEqual(rows.filter((row) => row.pollutant === 'CO2e').map((row) => [row.areaCode, row.value]),
        [['CAMX', 429.983], ['NYCW', 865.744]]);
    assert.deepEqual(rows[0], {
        level: 'subregion', areaCode: 'CAMX', areaName: 'WECC California', dataYear: 2023,
        pollutant: 'CO2', rateType: 'total output', value: 428.464, unit: 'lb/MWh',
        valueKgPerMWh: 428.464 * 0.45359237, kgUnit: 'kg/MWh', field: 'SRCO2RTA',
        fileName: latest.fileName, revision: 2, source: 'U.S. EPA eGRID 2023', sourceUrl: latest.sourceUrl,
    });
});

test('uses annual NOx and the published columns for state, national and non-baseload results', async () => {
    const cases = [
        [{ subregions: ['CAMX'], pollutants: ['NOx'] }, ['CAMX', 'WECC California', 'SRNOXRTA', 0.332]],
        [{ subregions: ['CAMX'], rateType: 'non-baseload', pollutants: ['NOx'] },
            ['CAMX', 'WECC California', 'SRNBNOX', 0.62]],
        [{ level: 'state', states: ['CA'], rateType: 'combustion', pollutants: ['CO2e'] },
            ['CA', 'California', 'STC2ECRT', 843.573]],
        [{ level: 'us', pollutants: ['CO2'] }, ['US', 'United States', 'USCO2RTA', 767.209]],
    ];
    for (const [input, expected] of cases) {
        const records = await parseWorkbook(latestXlsx, normalizeInput(input), latest);
        assert.deepEqual(records.map(({ areaCode, areaName, field, value }) => [areaCode, areaName, field, value]), [expected]);
    }
});

test('preserves old NERC methane rates and emits null for unpublished combustion CO2e', async () => {
    const input = normalizeInput({ level: 'nerc', rateType: 'combustion', pollutants: ['CH4', 'CO2e'] });
    const rows = await parseWorkbook(archivedXlsx, input, archived);
    const mro = rows.filter((row) => row.areaCode === 'MRO');
    assert.deepEqual(mro.map(({ field, unit, value, valueKgPerMWh }) => [field, unit, value, valueKgPerMWh]), [
        ['NRCH4CRT', 'lb/MWh', 0.185, 0.185 * 0.45359237],
        [null, 'lb/MWh', null, null],
    ]);
    const rates = await parseWorkbook(archivedXlsx,
        normalizeInput({ level: 'nerc', rateType: 'non-baseload', pollutants: ['CO2e'] }), archived);
    assert.ok(rates.every((row) => row.field === 'NRNBC2E' && typeof row.value === 'number'));
});

test('handles reordered fields and preserves the distinction between a missing rate and zero', async () => {
    const xlsx = await fixture('reordered-fields.xlsx');
    const options = normalizeInput({ pollutants: ['CO2'] });
    const read = (dataYear) => parseWorkbook(xlsx, options, { ...latest, dataYear, fileName: 'reordered-fields.xlsx' });
    assert.deepEqual((await read(2023)).map(({ value, valueKgPerMWh }) => [value, valueKgPerMWh]), [[0, 0], [null, null]]);
    await assert.rejects(read(2024), /unexpected label or unit for SRCO2RTA/);
    await assert.rejects(read(2025), /missing field SRCO2RTA/);
});

test('rejects unknown areas and wrong data formats with clear errors', async () => {
    await assert.rejects(parseWorkbook(latestXlsx, normalizeInput({ subregions: ['ABCD'] }), latest), /not in eGRID 2023: ABCD/);
    await assert.rejects(parseWorkbook(Buffer.from('<html>'), normalizeInput(), latest), /response is not an XLSX/);
    await assert.rejects(parseWorkbook(latestXlsx.subarray(0, 16), normalizeInput(), latest), /Unrecognized eGRID layout/);
    await assert.rejects(parseWorkbook(archivedXlsx, normalizeInput(), archived), /worksheet not found/);
    assert.throws(() => normalizeInput({ dataYears: ['2023'] }), /four-digit integer years/);
    assert.throws(() => normalizeInput({ pollutants: ['CO'] }), /Invalid input: pollutants/);
    const privatePath = ['C:', 'Users', 'local', 'sample', 'f.xlsx'].join('/');
    assert.equal(sanitize('cannot open ' + privatePath + '\ncheck input'), 'cannot open <path> check input');
});

function mockRun(responseFor, result) {
    const events = [];
    const output = [];
    return {
        events, output,
        dependencies: {
            async fetch(url, options) {
                assert.equal(options.redirect, 'manual');
                events.push(url);
                if (responseFor) {
                    const selected = responseFor(url);
                    if (selected) return selected;
                }
                const body = new Map([
                    [DETAILED_DATA, latestListing], [HISTORICAL_DATA, archiveListing],
                    [latest.sourceUrl, latestXlsx], [archived.sourceUrl, archivedXlsx],
                ]).get(url);
                assert.ok(body, 'Unexpected fetch ' + url);
                return new Response(body);
            },
            sleep: async (ms) => events.push(ms),
            actor: {
                async pushData(rows) {
                    output.push(...rows.slice(0, result?.chargedCount ?? rows.length));
                    return result;
                },
            },
        },
    };
}

test('discovers the latest year without calling the archive and waits between requests', async () => {
    const run = mockRun();
    const count = await runActor({ level: 'subregion', subregions: ['CAMX', 'NYCW'] }, run.dependencies);
    assert.equal(count, 8);
    assert.deepEqual(run.events, [DETAILED_DATA, 2350, latest.sourceUrl]);
    assert.ok(run.output.every((row) => row.dataYear === 2023));
});

test('fetches each requested workbook once and applies the PPE output limit', async () => {
    const run = mockRun(undefined, { eventChargeLimitReached: true, chargedCount: 3 });
    const count = await runActor({ level: 'nerc', dataYears: [2023, 2018, 2023], pollutants: ['CO2'] }, run.dependencies);
    assert.equal(count, 3);
    assert.deepEqual(run.events, [DETAILED_DATA, 2350, HISTORICAL_DATA, 2350, latest.sourceUrl, 2350, archived.sourceUrl]);
    assert.deepEqual(run.output.map((row) => row.dataYear), [2023, 2023, 2018]);
});

test('honors Retry-After, backs off after a network error and reports missing years', async () => {
    let attempts = 0;
    const run = mockRun((url) => {
        if (url !== DETAILED_DATA) return;
        attempts++;
        if (attempts === 1) return new Response('', { status: 429, headers: { 'Retry-After': '8' } });
        if (attempts === 2) throw new TypeError('network failure');
    });
    await assert.rejects(runActor({ dataYears: [2010] }, run.dependencies), /Available data years: 2023, 2018/);
    assert.deepEqual(run.events, [DETAILED_DATA, 8000, DETAILED_DATA, 4700, DETAILED_DATA, 2350, HISTORICAL_DATA]);
    assert.equal(run.output.length, 0);
});

test('stops on access denial and limits retries on server errors', async () => {
    const denied = mockRun(() => new Response('', { status: 403 }));
    await assert.rejects(runActor({}, denied.dependencies), /HTTP 403/);
    assert.deepEqual(denied.events, [DETAILED_DATA]);
    const temporary = mockRun(() => new Response('', { status: 503 }));
    await assert.rejects(runActor({}, temporary.dependencies), /HTTP 503/);
    assert.deepEqual(temporary.events, [DETAILED_DATA, 2350, DETAILED_DATA, 4700, DETAILED_DATA, 9400, DETAILED_DATA]);
});
