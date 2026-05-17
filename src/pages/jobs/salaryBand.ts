import { SalaryAnalysis, SalaryStats } from '../../api/client'

export type SalaryBandPosition = 'far-below' | 'below' | 'within' | 'above' | 'far-above'

export interface SalaryBandResult {
  position: SalaryBandPosition
  percentile: number   // 0-100, candidate's salary position vs distribution (approximate from p25/p50/p75 anchors)
  median: number
  p25: number
  p75: number
  verdictKey: 'verdictFarBelow' | 'verdictBelow' | 'verdictWithin' | 'verdictAbove' | 'verdictFarAbove'
  color: string        // hex for chip
  bgColor: string
}

/**
 * Approximate the candidate's percentile using p25, median, p75 anchors via
 * piecewise linear interpolation. Outside the IQR we extrapolate to min/max
 * (still loose so we don't over-promise precision).
 */
function approxPercentile(salary: number, s: SalaryStats): number {
  if (salary <= s.min) return 0
  if (salary >= s.max) return 100
  if (salary <= s.p25) return (salary - s.min)    / (s.p25    - s.min) * 25
  if (salary <= s.median) return 25 + (salary - s.p25)    / (s.median - s.p25)    * 25
  if (salary <= s.p75)    return 50 + (salary - s.median) / (s.p75    - s.median) * 25
  return 75 + (salary - s.p75) / (s.max - s.p75) * 25
}

/**
 * Compare a candidate's salary expectation to the job's salary analysis.
 * Returns null if either input is missing or salary <= 0.
 */
export function computeSalaryBand(
  candidateSalary: number | null | undefined,
  analysis: SalaryAnalysis | null | undefined,
): SalaryBandResult | null {
  if (!candidateSalary || candidateSalary <= 0 || !analysis) return null
  const s = analysis.overall
  if (s.count < 5) return null  // need enough data points to be meaningful

  const pct = approxPercentile(candidateSalary, s)
  let position: SalaryBandPosition
  let verdictKey: SalaryBandResult['verdictKey']
  let color: string
  let bgColor: string

  if (pct < 10) {
    position = 'far-below'
    verdictKey = 'verdictFarBelow'
    color    = '#1D4ED8'
    bgColor  = '#DBEAFE'
  } else if (pct < 25) {
    position = 'below'
    verdictKey = 'verdictBelow'
    color    = '#1E40AF'
    bgColor  = '#E0E7FF'
  } else if (pct <= 75) {
    position = 'within'
    verdictKey = 'verdictWithin'
    color    = '#065F46'
    bgColor  = '#D1FAE5'
  } else if (pct <= 90) {
    position = 'above'
    verdictKey = 'verdictAbove'
    color    = '#92400E'
    bgColor  = '#FEF3C7'
  } else {
    position = 'far-above'
    verdictKey = 'verdictFarAbove'
    color    = '#991B1B'
    bgColor  = '#FEE2E2'
  }

  return {
    position,
    percentile: Math.round(pct),
    median: s.median, p25: s.p25, p75: s.p75,
    verdictKey, color, bgColor,
  }
}

export function fmtUAH(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000).toLocaleString('en-US')}k ₴` : `${Math.round(n)} ₴`
}

export function fmtFullUAH(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} ₴`
}
