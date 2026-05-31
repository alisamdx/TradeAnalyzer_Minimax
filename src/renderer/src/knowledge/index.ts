// Knowledge base — tastylive strategy guide (TT1469)
// One entry per strategy; images live alongside as knowledge/images/{slug}.png

export interface StrategyGreeks {
  delta: string;
  vega: string;
  theta: string;
  gamma: string;
}

export interface StrategyExpiration {
  ifOTM: string;
  ifITM: string;
  other: string[];
}

export interface Strategy {
  slug: string;
  name: string;
  category: StrategyCategory;
  description: string;
  directionalAssumption: string;
  ivEnvironment: string;
  dte: string;
  probabilityOfProfit: string;
  setup: string[];
  maxProfit: string;
  maxLoss: string;
  profitTarget: string;
  breakeven: string;
  greeks: StrategyGreeks;
  howItWorks: {
    ideal: string;
    notIdeal: string;
    defensiveTactics: string;
  };
  volatility: {
    ifExpands: string;
    ifContracts: string;
  };
  expiration: StrategyExpiration;
  takeaways: string[];
}

export type StrategyCategory =
  | 'bullish'
  | 'bearish'
  | 'omnidirectional'
  | 'neutral'
  | 'neutral-bullish'
  | 'neutral-bearish';

export const CATEGORY_LABELS: Record<StrategyCategory, string> = {
  'bullish':          'Bullish',
  'bearish':          'Bearish',
  'omnidirectional':  'Omnidirectional',
  'neutral':          'Neutral',
  'neutral-bullish':  'Neutral / Bullish',
  'neutral-bearish':  'Neutral / Bearish',
};

export const CATEGORY_ORDER: StrategyCategory[] = [
  'bullish',
  'bearish',
  'omnidirectional',
  'neutral',
  'neutral-bullish',
  'neutral-bearish',
];

// ─── Import all JSON data files ───────────────────────────────────────────────

import coveredCall            from './data/covered-call.json';
import longCallVertical       from './data/long-call-vertical.json';
import callZebra              from './data/call-zebra.json';
import poorMansCoveredCall    from './data/poor-mans-covered-call.json';
import callCalendar           from './data/call-calendar.json';
import callButterfly          from './data/call-butterfly.json';
import bigLizard              from './data/big-lizard.json';
import coveredPut             from './data/covered-put.json';
import longPutVertical        from './data/long-put-vertical.json';
import putZebra               from './data/put-zebra.json';
import poorMansCoveredPut     from './data/poor-mans-covered-put.json';
import putCalendar            from './data/put-calendar.json';
import putButterfly           from './data/put-butterfly.json';
import reverseBigLizard       from './data/reverse-big-lizard.json';
import putFrontRatio          from './data/put-front-ratio.json';
import callFrontRatio         from './data/call-front-ratio.json';
import putBrokenWingButterfly from './data/put-broken-wing-butterfly.json';
import callBrokenWingButterfly from './data/call-broken-wing-butterfly.json';
import callBrokenHeartButterfly from './data/call-broken-heart-butterfly.json';
import putBrokenHeartButterfly from './data/put-broken-heart-butterfly.json';
import shortStrangle          from './data/short-strangle.json';
import shortStraddle          from './data/short-straddle.json';
import ironCondor             from './data/iron-condor.json';
import dynamicWidthIronCondor from './data/dynamic-width-iron-condor.json';
import ironFly                from './data/iron-fly.json';
import shortNakedPut          from './data/short-naked-put.json';
import shortPutVertical       from './data/short-put-vertical.json';
import jadeLizard             from './data/jade-lizard.json';
import shortNakedCall         from './data/short-naked-call.json';
import shortCallVertical      from './data/short-call-vertical.json';
import reverseJadeLizard      from './data/reverse-jade-lizard.json';

export const STRATEGIES: Strategy[] = [
  coveredCall,
  longCallVertical,
  callZebra,
  poorMansCoveredCall,
  callCalendar,
  callButterfly,
  bigLizard,
  coveredPut,
  longPutVertical,
  putZebra,
  poorMansCoveredPut,
  putCalendar,
  putButterfly,
  reverseBigLizard,
  putFrontRatio,
  callFrontRatio,
  putBrokenWingButterfly,
  callBrokenWingButterfly,
  callBrokenHeartButterfly,
  putBrokenHeartButterfly,
  shortStrangle,
  shortStraddle,
  ironCondor,
  dynamicWidthIronCondor,
  ironFly,
  shortNakedPut,
  shortPutVertical,
  jadeLizard,
  shortNakedCall,
  shortCallVertical,
  reverseJadeLizard,
] as Strategy[];

export const STRATEGIES_BY_CATEGORY: Record<StrategyCategory, Strategy[]> =
  CATEGORY_ORDER.reduce((acc, cat) => {
    acc[cat] = STRATEGIES.filter(s => s.category === cat);
    return acc;
  }, {} as Record<StrategyCategory, Strategy[]>);
