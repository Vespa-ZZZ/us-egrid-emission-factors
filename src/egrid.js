import { Readable } from 'node:stream';
import { load } from 'cheerio';
import ExcelJS from 'exceljs';

const EPA = 'https://www.epa.gov';
export const DETAILED_DATA = EPA + '/egrid/detailed-data';
export const HISTORICAL_DATA = EPA + '/egrid/historical-egrid-data';
const WORKBOOK_NAME = /^egrid(\d{4})_data(?:_(?:rev|v)(\d+))?\.xlsx$/i;
const LB_TO_KG = 0.45359237;

const LEVELS = {
    subregion: { sheet: 'SRL', prefix: 'SR', label: 'egrid subregion', code: 'SUBRGN', name: 'SRNAME' },
    state: { sheet: 'ST', prefix: 'ST', label: 'state', code: 'PSTATABB' },
    us: { sheet: 'US', prefix: 'US', label: 'u.s.' },
    nerc: { sheet: 'NRL', prefix: 'NR', label: 'nerc region', code: 'NERC', name: 'NERCNAME' },
};
const RATE_LABELS = {
    'total output': 'total output',
    'non-baseload': 'non-baseload output',
    combustion: 'combustion output',
};
const POLLUTANT_CODES = { CO2: 'CO2', CH4: 'CH4', N2O: 'N2O', CO2e: 'C2E', NOx: 'NOX', SO2: 'SO2' };
const POLLUTANTS = Object.keys(POLLUTANT_CODES);
const DEFAULT_POLLUTANTS = ['CO2', 'CH4', 'N2O', 'CO2e'];
const STATE_NAMES = {
    AK: 'Alaska', AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', IA: 'Iowa', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky',
    LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine', MI: 'Michigan', MN: 'Minnesota',
    MO: 'Missouri', MS: 'Mississippi', MT: 'Montana', NC: 'North Carolina', ND: 'North Dakota',
    NE: 'Nebraska', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada',
    NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VA: 'Virginia', VT: 'Vermont', WA: 'Washington', WI: 'Wisconsin',
    WV: 'West Virginia', WY: 'Wyoming',
};

function readArray(input, key, isValid, expectation, defaultValue = []) {
    const items = input[key] ?? defaultValue;
    if (!Array.isArray(items) || !items.every(isValid)) {
        throw new Error('Invalid input: ' + key + ' must be an array of ' + expectation + '.');
    }
    return items;
}

export function normalizeInput(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Invalid input: expected a JSON object.');
    }
    const level = input.level ?? 'subregion';
    const rateType = input.rateType ?? 'total output';
    if (typeof level !== 'string' || !Object.hasOwn(LEVELS, level)) {
        throw new Error('Invalid input: level must be subregion, state, us or nerc.');
    }
    if (typeof rateType !== 'string' || !Object.hasOwn(RATE_LABELS, rateType)) {
        throw new Error('Invalid input: rateType must be total output, non-baseload or combustion.');
    }
    const dataYears = readArray(input, 'dataYears', (item) => Number.isInteger(item) && item >= 1900 && item <= 9999,
        'four-digit integer years');
    const requested = readArray(input, 'pollutants', (item) => typeof item === 'string'
        && POLLUTANTS.some((name) => name.toUpperCase() === item.trim().toUpperCase()), POLLUTANTS.join(', '));
    let areas = [];
    if (level === 'subregion') {
        areas = readArray(input, 'subregions', (item) => typeof item === 'string' && /^[a-z]{4}$/i.test(item.trim()),
            'four-letter eGRID subregion codes');
    } else if (level === 'state') {
        areas = readArray(input, 'states', (item) => typeof item === 'string'
            && Object.hasOwn(STATE_NAMES, item.trim().toUpperCase()), 'two-letter postal codes');
    }

    const requestedCodes = new Set(requested.map((name) => name.trim().toUpperCase()));
    return {
        level,
        rateType,
        dataYears: [...new Set(dataYears)],
        areas: [...new Set(areas.map((code) => code.trim().toUpperCase()))],
        pollutants: requested.length ? POLLUTANTS.filter((name) => requestedCodes.has(name.toUpperCase())) : DEFAULT_POLLUTANTS,
    };
}

export function discoverWorkbooks(html, listingUrl) {
    const $ = load(html);
    const books = new Map();
    for (const link of $('main a[href]')) {
        const text = $(link).text().trim();
        const declaredYear = /^(?:download\s+)?egrid\s*(\d{4})(?:\s+data file)?\s*\(xlsx\)$/i.exec(text)?.[1];
        let url;
        try {
            url = new URL($(link).attr('href'), listingUrl);
        } catch {
            if (declaredYear) throw new Error('Unrecognized EPA workbook link on ' + listingUrl + '.');
            continue;
        }
        const fileName = url.pathname.split('/').at(-1);
        const match = WORKBOOK_NAME.exec(fileName);
        if (!match && !declaredYear) continue;
        if (!match || (declaredYear && match[1] !== declaredYear) || url.origin !== EPA
            || url.username || url.password || url.search || url.hash
            || !/^\/(?:system\/files\/documents|sites\/default\/files)\//.test(url.pathname)) {
            throw new Error('Unrecognized EPA workbook link on ' + listingUrl + '.');
        }
        const dataYear = Number(match[1]);
        const revision = match[2] ? Number(match[2]) : null;
        const current = books.get(dataYear);
        if (current && current.revision === revision && current.sourceUrl !== url.href) {
            throw new Error('EPA lists multiple workbook URLs for the same eGRID ' + dataYear + ' revision.');
        }
        if (!current || (revision ?? 0) > (current.revision ?? 0)) {
            books.set(dataYear, { dataYear, revision, fileName, sourceUrl: url.href });
        }
    }
    if (!books.size) throw new Error('Unrecognized EPA listing: no eGRID data workbooks on ' + listingUrl + '.');
    if (listingUrl === DETAILED_DATA) {
        const advertisedYears = $('main h2').toArray().flatMap((heading) => {
            const year = /^egrid with (\d{4}) data$/i.exec($(heading).text().trim())?.[1];
            return year ? [Number(year)] : [];
        });
        if (advertisedYears.some((year) => !books.has(year))) {
            throw new Error('Unrecognized EPA listing: the advertised eGRID year has no data workbook.');
        }
    }
    return books;
}

function cellText(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value?.richText)) return value.richText.map((part) => part.text).join('').trim();
    return '';
}

function labelText(value) {
    return cellText(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function rateField(prefix, rateType, pollutant) {
    const code = POLLUTANT_CODES[pollutant];
    if (rateType === 'non-baseload') return prefix + 'NB' + code;
    return prefix + code + (rateType === 'combustion' ? 'CRT' : 'RTA');
}

function findColumns(codes, labels, input, level, dataYear, fail) {
    const indexes = new Map();
    codes.forEach((value, column) => {
        const code = cellText(value).toUpperCase();
        if (!code) return;
        if (indexes.has(code)) throw fail('duplicate field code ' + code);
        indexes.set(code, column);
    });
    function get(code) {
        const index = indexes.get(code);
        if (index === undefined) throw fail('missing field ' + code);
        return index;
    }
    const year = get('YEAR');
    if (labelText(labels[year]) !== 'data year') throw fail('invalid YEAR label');
    const rates = input.pollutants.map((pollutant) => {
        const field = rateField(level.prefix, input.rateType, pollutant);
        // EPA first published the combustion CO2e field in the 2019 edition.
        if (dataYear === 2018 && pollutant === 'CO2e' && input.rateType === 'combustion' && !indexes.has(field)) {
            return { pollutant, field: null, column: null };
        }
        const column = get(field);
        let label = labelText(labels[column]);
        if (dataYear <= 2022 && field === 'NRNBC2E') label = label.replace('equiavlent', 'equivalent');
        // Older workbooks mislabeled NRCH4CRT as lb/GWh. Values and the EPA guides use lb/MWh.
        if (dataYear >= 2018 && dataYear <= 2022 && field === 'NRCH4CRT') {
            label = label.replace('(lb/gwh)', '(lb/mwh)');
        }
        const names = pollutant === 'CO2e' ? ['co2 equivalent', 'co2e'] : [pollutant.toLowerCase()];
        label = label.replace('nonbaseload', 'non-baseload');
        if (!names.some((name) => label === level.label + ' annual ' + name + ' '
            + RATE_LABELS[input.rateType] + ' emission rate (lb/mwh)')) {
            throw fail('unexpected label or unit for ' + field);
        }
        return { pollutant, field, column };
    });
    return { year, code: level.code ? get(level.code) : null, name: level.name ? get(level.name) : null, rates };
}

function rateValue(value, field, fail) {
    const cell = value?.formula != null || value?.sharedFormula != null ? value.result : value;
    if (cell == null || (typeof cell === 'string' && /^(?:\s*|N\/?A|--?|—)$/i.test(cell.trim()))) return null;
    if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
    throw fail('invalid numeric value in ' + field);
}

async function readSheet(sheet, input, book, fail) {
    const { dataYear, revision, fileName, sourceUrl } = book;
    const level = LEVELS[input.level];
    const seenAreas = new Set();
    const records = [];
    let columns;
    let previousRow;
    for await (const row of sheet) {
        if (!row.hasValues) continue;
        if (!columns) {
            if (row.number > 20) throw fail('missing the two-row header');
            if (row.values.some((cell) => cellText(cell).toUpperCase() === 'YEAR')) {
                if (previousRow?.number !== row.number - 1) throw fail('missing descriptive header');
                columns = findColumns(row.values, previousRow.values, input, level, dataYear, fail);
            }
            previousRow = row;
            continue;
        }
        if (Number(row.getCell(columns.year).value) !== dataYear) throw fail('unexpected data year on row ' + row.number);
        const areaCode = columns.code ? cellText(row.getCell(columns.code).value) : 'US';
        const areaName = columns.name ? cellText(row.getCell(columns.name).value)
            : input.level === 'us' ? 'United States' : STATE_NAMES[areaCode];
        if (!/^[A-Z0-9]{2,8}$/.test(areaCode) || !areaName) throw fail('invalid area on row ' + row.number);
        if (seenAreas.has(areaCode)) throw fail('duplicate area ' + areaCode);
        seenAreas.add(areaCode);
        if (input.areas.length && !input.areas.includes(areaCode)) continue;

        for (const { pollutant, field, column } of columns.rates) {
            const value = column ? rateValue(row.getCell(column).value, field, fail) : null;
            records.push({
                level: input.level, areaCode, areaName, dataYear, pollutant, rateType: input.rateType,
                value, unit: 'lb/MWh', valueKgPerMWh: value === null ? null : value * LB_TO_KG, kgUnit: 'kg/MWh',
                field, fileName, revision, source: 'U.S. EPA eGRID ' + dataYear, sourceUrl,
            });
        }
    }
    if (!columns) throw fail('missing the two-row header');
    if (!seenAreas.size) throw fail('no data rows');
    const missing = input.areas.filter((code) => !seenAreas.has(code));
    if (missing.length) throw new MissingAreaError('Area code(s) not in eGRID ' + dataYear + ': ' + missing.join(', ') + '.');
    return records;
}

export async function parseWorkbook(bytes, input, book) {
    const expected = LEVELS[input.level].sheet + String(book.dataYear).slice(-2);
    const fail = (reason) => new WorkbookLayoutError('Unrecognized eGRID layout in ' + book.fileName
        + ' (' + expected + '): ' + reason + '.');
    if (bytes.subarray(0, 4).toString('hex') !== '504b0304') throw fail('the response is not an XLSX file');

    try {
        // Stream the workbook and read only the selected aggregation worksheet.
        const workbook = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([bytes]));
        let records;
        for await (const sheet of workbook) {
            if (sheet.name?.toUpperCase() !== expected) continue;
            if (records) throw fail('duplicate worksheet');
            records = await readSheet(sheet, input, book, fail);
        }
        if (!records) throw fail('worksheet not found');
        return records;
    } catch (error) {
        if (error instanceof WorkbookLayoutError || error instanceof MissingAreaError) throw error;
        throw fail('could not read the XLSX worksheet');
    }
}

class WorkbookLayoutError extends Error {}
class MissingAreaError extends Error {}

export function sanitize(message) {
    return String(message)
        .replace(/(?:file:\/\/\/)?\b[A-Za-z]:[\\/][^\s"'<>]+/g, '<path>')
        .replace(/(?:file:\/\/)?\/(?:home|Users|tmp|private\/var|var\/folders)\/[^\s"'<>]+/g, '<path>')
        .replace(/[\r\n]+/g, ' ');
}
