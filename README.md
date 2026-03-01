# SpreadScout API

SpreadScout is a Node.js service that scans Binance and KuCoin spot prices for configured pairs and returns opportunities that are:
- Net-profitable after fees/slippage/transfer cost assumptions
- Above a configurable minimum threshold
- In a bullish short-term trend

## Prerequisites

- Node.js 18+
- npm

## Installation

```sh
npm install
```

## Run

```sh
npm start
```

Server default URL: `http://localhost:3000`

## API

`GET /check-arbitrage`

Optional query params:
- `force=1`: bypass cache and trigger a fresh scan

Sample response:

```json
{
  "opportunities": [
    {
      "pair": "BTC-USDT",
      "opportunity": "Buy on KuCoin, Sell on Binance",
      "kuCoinPrice": 68000.12,
      "binancePrice": 68610.55,
      "netSpreadPct": 0.4321
    }
  ],
  "metadata": {
    "scanCacheTtlMs": 15000,
    "lastScanAt": "2026-03-01T06:20:00.000Z",
    "pairCount": 50
  }
}
```

## Configuration

All runtime settings are in `config.json`.

Core fields:
- `pairs`: symbols in KuCoin format, e.g. `BTC-USDT`
- `threshold`: minimum net spread required (decimal, e.g. `0.01` = 1%)
- `historicalPriceLimit`: number of candles for trend check
- `historicalInterval`: Binance kline interval (e.g. `1h`)

Reliability and load controls:
- `requestTimeoutMs`: per-API call timeout
- `requestRetries`: retry count for failed API calls
- `maxConcurrency`: max simultaneous pair checks
- `scanCacheTtlMs`: cache window for scan results
- `minRequestIntervalMs`: per-IP endpoint cooldown

Profitability assumptions:
- `kucoinTakerFeeRate`
- `binanceTakerFeeRate`
- `slippageRate`
- `transferCostUSDT`
- `tradeNotionalUSDT`

## Notes

- This project only identifies potential opportunities; it does not execute trades.
- Public API limits can still vary by exchange and region.
