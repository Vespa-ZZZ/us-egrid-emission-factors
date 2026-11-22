# US eGRID Electricity Emission Factors

Retrieve EPA's published annual electricity emission rates for eGRID subregions, states and territories, NERC regions, or the United States. Use the results to look up factors for facilities in multiple grid regions, compare published rates across years, or record the source workbook and revision used in an emissions inventory.

## Input

| Field | Default | What it selects |
| --- | --- | --- |
| `level` | `subregion` | `subregion`, `state`, `us`, or `nerc`. |
| `subregions` | All published subregions | Four-letter EPA codes such as `CAMX`, `NYCW`, or `ERCT`. Applies to `subregion` only. |
| `states` | All published states and territories | Two-letter postal codes such as `CA`, `NY`, or `PR`. Applies to `state` only. |
| `dataYears` | Latest data year | An array of integer data years such as `[2023, 2022]`. The Actor discovers separately linked US-unit XLSX workbooks in EPA's current and historical listings. EPA's 1996–2016 ZIP archive is outside this workbook format. |
| `pollutants` | `["CO2", "CH4", "N2O", "CO2e"]` | Any combination of `CO2`, `CH4`, `N2O`, `CO2e`, `NOx`, and `SO2`. NOx rates are annual. |
| `rateType` | `total output` | `total output`, `non-baseload`, or `combustion`. |

Omit a list or pass an empty array to use its default. Every explicit area code must be present in every requested year. The NERC and US levels return all entries published for that level.

Latest total output rates for California's eGRID subregion and the NYC/Westchester subregion.

```json
{"level":"subregion","subregions":["CAMX","NYCW"]}
```

Compare California and New York state combustion rates across two data years.

```json
{"level":"state","states":["CA","NY"],"dataYears":[2023,2022],"pollutants":["CO2","CO2e"],"rateType":"combustion"}
```

## Rate columns

EPA workbook field codes start with `SR` for subregion, `ST` for state, `NR` for NERC region, and `US` for the national total. The table gives the part after that prefix.

| Pollutant | Total output | Non-baseload output | Combustion output |
| --- | --- | --- | --- |
| CO2 | `CO2RTA` | `NBCO2` | `CO2CRT` |
| CH4 | `CH4RTA` | `NBCH4` | `CH4CRT` |
| N2O | `N2ORTA` | `NBN2O` | `N2OCRT` |
| CO2e | `C2ERTA` | `NBC2E` | `C2ECRT` |
| NOx | `NOXRTA` | `NBNOX` | `NOXCRT` |
| SO2 | `SO2RTA` | `NBSO2` | `SO2CRT` |

The Actor uses EPA's stored rates in lb/MWh, including EPA's own CO2e values. It converts pounds to kilograms by multiplying by 0.45359237. Blank or unpublished rates return `null` for both values. The combustion CO2e column first appeared in eGRID2019, so eGRID2018 rows for that combination also have a null field code. For older workbooks with an lb/GWh label on `NRCH4CRT`, the Actor follows the lb/MWh unit documented for that field by EPA. [EPA eGRID FAQ](https://www.epa.gov/egrid/frequent-questions-about-egrid) · [eGRID2022 Technical Guide, Appendix A](https://www.epa.gov/system/files/documents/2024-01/egrid2022_technical_guide.pdf)

## Output

The dataset contains one row per area, data year, rate type, and pollutant. The revision comes from the workbook filename when present. The data year identifies the underlying observations.

```json
{
  "level": "subregion",
  "areaCode": "CAMX",
  "areaName": "WECC California",
  "dataYear": 2023,
  "pollutant": "CO2",
  "rateType": "total output",
  "value": 428.464,
  "unit": "lb/MWh",
  "valueKgPerMWh": 194.34800121968001,
  "kgUnit": "kg/MWh",
  "field": "SRCO2RTA",
  "fileName": "egrid2023_data_rev2.xlsx",
  "revision": 2,
  "source": "U.S. EPA eGRID 2023",
  "sourceUrl": "https://www.epa.gov/system/files/documents/2025-06/egrid2023_data_rev2.xlsx"
}
```

## Source and reuse

Source credit goes to the United States Environmental Protection Agency, Emissions & Generation Resource Integrated Database (eGRID), for the data year shown in each result. EPA makes eGRID data available in the public domain for commercial and non-commercial use. This independent Actor selects and formats EPA's area-level rates and adds the kilogram conversion. It has no affiliation with EPA. [Current data](https://www.epa.gov/egrid/detailed-data) · [Historical data](https://www.epa.gov/egrid/historical-egrid-data) · [EPA reuse and citation guidance](https://www.epa.gov/egrid/frequent-questions-about-egrid)

The Actor requests the current listing, then the historical listing if needed, and downloads each selected workbook once per run. Requests are sequential with at least 2.35 seconds between them. The Actor stops on access denial or an unrecognized workbook layout.

## 日本語概要

米国 EPA の eGRID から、電力網サブリージョン・州・NERC 地域・米国全体の年間排出係数を取得します。年を省略すると EPA が掲載する最新のデータ年を選択します。結果には EPA の公表値（lb/MWh）、換算値（kg/MWh）、出典ファイルと改訂番号を収録します。
