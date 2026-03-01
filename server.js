const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const app = express();

const port = Number.isFinite(Number(config.port)) ? Number(config.port) : 3000;
const pairs = Array.isArray(config.pairs) ? config.pairs : [];
const threshold = Number.isFinite(Number(config.threshold)) ? Number(config.threshold) : 0.01;
const historicalPriceLimit = Number.isFinite(Number(config.historicalPriceLimit))
  ? Number(config.historicalPriceLimit)
  : 10;
const historicalInterval = config.historicalInterval || '1h';
const kucoinApiUrl = config.kucoinApiUrl;
const binanceApiUrl = config.binanceApiUrl;
const binanceKlinesApiUrl = config.binanceKlinesApiUrl;

const requestTimeoutMs = Number.isFinite(Number(config.requestTimeoutMs))
  ? Number(config.requestTimeoutMs)
  : 5000;
const requestRetries = Number.isFinite(Number(config.requestRetries))
  ? Number(config.requestRetries)
  : 1;
const maxConcurrency = Number.isFinite(Number(config.maxConcurrency))
  ? Number(config.maxConcurrency)
  : 6;
const scanCacheTtlMs = Number.isFinite(Number(config.scanCacheTtlMs))
  ? Number(config.scanCacheTtlMs)
  : 15000;
const minRequestIntervalMs = Number.isFinite(Number(config.minRequestIntervalMs))
  ? Number(config.minRequestIntervalMs)
  : 2000;

const kucoinTakerFeeRate = Number.isFinite(Number(config.kucoinTakerFeeRate))
  ? Number(config.kucoinTakerFeeRate)
  : 0.001;
const binanceTakerFeeRate = Number.isFinite(Number(config.binanceTakerFeeRate))
  ? Number(config.binanceTakerFeeRate)
  : 0.001;
const slippageRate = Number.isFinite(Number(config.slippageRate))
  ? Number(config.slippageRate)
  : 0.0005;
const transferCostUSDT = Number.isFinite(Number(config.transferCostUSDT))
  ? Number(config.transferCostUSDT)
  : 0;
const tradeNotionalUSDT = Number.isFinite(Number(config.tradeNotionalUSDT))
  ? Number(config.tradeNotionalUSDT)
  : 1000;

const http = axios.create({ timeout: requestTimeoutMs });

let inFlightScanPromise = null;
let lastScanAt = 0;
let lastScanResults = [];
const lastRequestByIp = new Map();

function parseFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWithRetry(url, retries = requestRetries) {
  let attempt = 0;
  let lastError = null;
  while (attempt <= retries) {
    try {
      return await http.get(url);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        throw error;
      }
      await sleep(250 * (attempt + 1));
      attempt += 1;
    }
  }
  throw lastError;
}

async function getKuCoinPrice(pair) {
  try {
    const response = await getWithRetry(`${kucoinApiUrl}${pair}`);
    return parseFiniteNumber(response?.data?.data?.price);
  } catch (error) {
    console.error(`Error fetching price from KuCoin for ${pair}: ${error.message}`);
    return null;
  }
}

async function getBinancePrice(pair) {
  const binancePair = pair.replace('-', '');
  try {
    const response = await getWithRetry(`${binanceApiUrl}${binancePair}`);
    return parseFiniteNumber(response?.data?.price);
  } catch (error) {
    console.error(`Error fetching price from Binance for ${binancePair}: ${error.message}`);
    return null;
  }
}

async function getHistoricalPrices(pair, limit = historicalPriceLimit) {
  const binancePair = pair.replace('-', '');
  try {
    const response = await getWithRetry(
      `${binanceKlinesApiUrl}${binancePair}&interval=${historicalInterval}&limit=${limit}`
    );
    const closingPrices = response.data
      .map((candle) => parseFiniteNumber(candle[4]))
      .filter((price) => price !== null);
    return closingPrices.length > 1 ? closingPrices : null;
  } catch (error) {
    console.error(`Error fetching historical prices for ${binancePair}: ${error.message}`);
    return null;
  }
}

function isBullishTrend(historicalPrices) {
  if (!historicalPrices || historicalPrices.length < 2) {
    return false;
  }
  const movingAverage =
    historicalPrices.reduce((sum, price) => sum + price, 0) / historicalPrices.length;
  const currentPrice = historicalPrices[historicalPrices.length - 1];
  return currentPrice > movingAverage;
}

function calculateNetSpreadPct({
  buyPrice,
  sellPrice,
  buyFeeRate,
  sellFeeRate
}) {
  const effectiveBuy = buyPrice * (1 + buyFeeRate + slippageRate);
  const effectiveSell = sellPrice * (1 - sellFeeRate - slippageRate);
  const grossSpreadPct = (effectiveSell - effectiveBuy) / effectiveBuy;
  const transferCostPct = transferCostUSDT / tradeNotionalUSDT;
  return grossSpreadPct - transferCostPct;
}

async function checkArbitrage(pair) {
  const [kuCoinPrice, binancePrice] = await Promise.all([
    getKuCoinPrice(pair),
    getBinancePrice(pair)
  ]);

  if (!Number.isFinite(kuCoinPrice) || !Number.isFinite(binancePrice)) {
    return null;
  }

  const buyKucoinSellBinanceNetPct = calculateNetSpreadPct({
    buyPrice: kuCoinPrice,
    sellPrice: binancePrice,
    buyFeeRate: kucoinTakerFeeRate,
    sellFeeRate: binanceTakerFeeRate
  });

  const buyBinanceSellKucoinNetPct = calculateNetSpreadPct({
    buyPrice: binancePrice,
    sellPrice: kuCoinPrice,
    buyFeeRate: binanceTakerFeeRate,
    sellFeeRate: kucoinTakerFeeRate
  });

  let opportunity = null;
  if (buyKucoinSellBinanceNetPct >= threshold) {
    opportunity = {
      pair,
      opportunity: 'Buy on KuCoin, Sell on Binance',
      kuCoinPrice,
      binancePrice,
      netSpreadPct: Number((buyKucoinSellBinanceNetPct * 100).toFixed(4))
    };
  } else if (buyBinanceSellKucoinNetPct >= threshold) {
    opportunity = {
      pair,
      opportunity: 'Buy on Binance, Sell on KuCoin',
      kuCoinPrice,
      binancePrice,
      netSpreadPct: Number((buyBinanceSellKucoinNetPct * 100).toFixed(4))
    };
  }

  if (!opportunity) {
    return null;
  }

  const historicalPrices = await getHistoricalPrices(pair);
  return isBullishTrend(historicalPrices) ? opportunity : null;
}

async function mapWithConcurrency(items, limit, asyncMapper) {
  const normalizedLimit = Math.max(1, Math.min(limit, items.length || 1));
  const results = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: normalizedLimit }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        break;
      }
      results[current] = await asyncMapper(items[current]);
    }
  });

  await Promise.all(workers);
  return results;
}

async function performScan() {
  const results = await mapWithConcurrency(pairs, maxConcurrency, checkArbitrage);
  return results.filter((result) => result !== null);
}

async function getCachedOpportunities(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && now - lastScanAt < scanCacheTtlMs) {
    return lastScanResults;
  }
  if (inFlightScanPromise) {
    return inFlightScanPromise;
  }

  inFlightScanPromise = performScan()
    .then((opportunities) => {
      lastScanResults = opportunities;
      lastScanAt = Date.now();
      return opportunities;
    })
    .finally(() => {
      inFlightScanPromise = null;
    });

  return inFlightScanPromise;
}

app.get('/check-arbitrage', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const lastRequestAt = lastRequestByIp.get(ip) || 0;

  if (now - lastRequestAt < minRequestIntervalMs) {
    const retryAfterMs = minRequestIntervalMs - (now - lastRequestAt);
    return res.status(429).json({
      error: 'Too many requests',
      retryAfterMs
    });
  }

  lastRequestByIp.set(ip, now);

  try {
    const forceRefresh = req.query.force === '1';
    const opportunities = await getCachedOpportunities(forceRefresh);
    return res.json({
      opportunities,
      metadata: {
        scanCacheTtlMs,
        lastScanAt: lastScanAt ? new Date(lastScanAt).toISOString() : null,
        pairCount: pairs.length
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'An error occurred while scanning arbitrage pairs' });
  }
});

app.listen(port, () => {
  console.log(`SpreadScout API listening at http://localhost:${port}`);
});
