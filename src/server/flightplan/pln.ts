// Reading and writing MSFS 2020 .PLN flight plan files (AceXML).
import { randomUUID } from 'node:crypto';
import type { FlightPlan, PlanProcedures, PlanWaypoint, WaypointType } from '../../shared/types.js';

const TYPE_TO_PLN: Record<WaypointType, string> = {
  airport: 'Airport',
  vor: 'VOR',
  ndb: 'NDB',
  fix: 'Intersection',
  user: 'User',
};
const PLN_TO_TYPE: Record<string, WaypointType> = {
  airport: 'airport',
  vor: 'vor',
  ndb: 'ndb',
  intersection: 'fix',
  user: 'user',
};

// Approach names in the UI ("ILS 24") <-> PLN ApproachTypeFP values.
const APPROACH_TYPES: Record<string, string> = {
  GPS: 'GPS',
  VOR: 'VOR',
  NDB: 'NDB',
  ILS: 'ILS',
  LOC: 'LOCALIZER',
  SDF: 'SDF',
  LDA: 'LDA',
  'VOR/DME': 'VORDME',
  'NDB/DME': 'NDBDME',
  RNAV: 'RNAV',
  'LOC BC': 'LOCALIZER_BACKCOURSE',
};
const DESIGNATORS: Record<string, string> = { L: 'LEFT', R: 'RIGHT', C: 'CENTER', W: 'WATER', A: 'A', B: 'B' };

/** Waypoints the MSFS World Map inserts for its own vertical profile; not real fixes. */
const SIM_PSEUDO_WAYPOINT = /^TIME(CLIMB|CRUIS|DSCNT|APPR|VERT)/i;

// ---------------------------------------------------------------- Coordinates

function toDms(value: number, pos: string, neg: string): string {
  const hemi = value >= 0 ? pos : neg;
  let abs = Math.abs(value);
  let deg = Math.floor(abs);
  abs = (abs - deg) * 60;
  let min = Math.floor(abs);
  let sec = Number(((abs - min) * 60).toFixed(2));
  if (sec >= 60) { sec = 0; min += 1; }
  if (min >= 60) { min = 0; deg += 1; }
  return `${hemi}${deg}° ${min}' ${sec.toFixed(2)}"`;
}

export function formatLla(lat: number, lon: number, altFt: number): string {
  const sign = altFt < 0 ? '-' : '+';
  const alt = Math.abs(altFt).toFixed(2).padStart(9, '0');
  return `${toDms(lat, 'N', 'S')},${toDms(lon, 'E', 'W')},${sign}${alt}`;
}

const LLA_RE = /([NS])\s*([\d.]+)°\s*([\d.]+)'\s*([\d.]+)"\s*,\s*([EW])\s*([\d.]+)°\s*([\d.]+)'\s*([\d.]+)"\s*(?:,\s*([+-]?[\d.]+))?/;

export function parseLla(text: string): { lat: number; lon: number; altFt: number } | null {
  const m = LLA_RE.exec(text);
  if (!m) return null;
  const lat = (Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600) * (m[1] === 'S' ? -1 : 1);
  const lon = (Number(m[6]) + Number(m[7]) / 60 + Number(m[8]) / 3600) * (m[5] === 'W' ? -1 : 1);
  return { lat, lon, altFt: m[9] ? Number(m[9]) : 0 };
}

// ---------------------------------------------------------------- Runways / approaches

export function splitRunway(runway: string): { number: string; designator: string | null } {
  const m = /^(\d{1,2})([LRCWAB])?$/i.exec(runway.trim());
  if (!m) return { number: runway.trim(), designator: null };
  return { number: String(Number(m[1])), designator: m[2] ? DESIGNATORS[m[2].toUpperCase()] ?? null : null };
}

function joinRunway(number: string | undefined, designator: string | undefined): string | undefined {
  if (!number) return undefined;
  const des = Object.entries(DESIGNATORS).find(([, v]) => v === designator?.toUpperCase())?.[0] ?? '';
  return number.padStart(2, '0') + des;
}

/** "RNAV 22L Z" -> { type: 'RNAV', runway: '22L', suffix: 'Z' } */
export function parseApproachName(name: string): { type: string; runway: string; suffix: string | null } | null {
  const m = /^(LOC BC|VOR\/DME|NDB\/DME|[A-Z]+)\s+(\d{1,2}[LRCWAB]?)(?:\s*-?\s*([A-Z]))?$/i.exec(name.trim());
  if (!m || !APPROACH_TYPES[m[1].toUpperCase()]) return null;
  return { type: m[1].toUpperCase(), runway: m[2].toUpperCase(), suffix: m[3]?.toUpperCase() ?? null };
}

// ---------------------------------------------------------------- Writing

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function plnId(wp: PlanWaypoint, index: number): string {
  const clean = wp.ident.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.slice(0, 10) || `WPT${index}`;
}

export function buildPln(plan: FlightPlan): string {
  const wps = plan.waypoints;
  if (wps.length < 2) throw new Error('A flight plan needs at least two waypoints.');
  const dep = wps[0];
  const dest = wps[wps.length - 1];
  const proc: PlanProcedures = plan.procedures ?? {};
  const enroute = wps.slice(1, -1);
  const firstEnroute = enroute[0];
  const lastEnroute = enroute[enroute.length - 1];
  const approach = proc.approach ? parseApproachName(proc.approach) : null;
  const expanded = wps.some((w) => w.procedure);

  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  out('<?xml version="1.0" encoding="UTF-8"?>');
  out('');
  out('<SimBase.Document Type="AceXML" version="1,0">');
  out('    <Descr>AceXML Document</Descr>');
  out('    <FlightPlan.FlightPlan>');
  out(`        <Title>${esc(plan.title || `${dep.ident} to ${dest.ident}`)}</Title>`);
  out(`        <FPType>${plan.rules}</FPType>`);
  out(`        <RouteType>${plan.cruiseAltFt >= 18000 ? 'HighAlt' : 'LowAlt'}</RouteType>`);
  out(`        <CruisingAlt>${Math.round(plan.cruiseAltFt).toFixed(3)}</CruisingAlt>`);
  out(`        <DepartureID>${esc(dep.ident)}</DepartureID>`);
  out(`        <DepartureLLA>${formatLla(dep.lat, dep.lon, dep.altFt ?? 0)}</DepartureLLA>`);
  out(`        <DestinationID>${esc(dest.ident)}</DestinationID>`);
  out(`        <DestinationLLA>${formatLla(dest.lat, dest.lon, dest.altFt ?? 0)}</DestinationLLA>`);
  out(`        <Descr>${esc(plan.title || `${dep.ident}, ${dest.ident}`)}</Descr>`);
  if (dep.type === 'airport' && proc.departureRunway) out(`        <DeparturePosition>${esc(proc.departureRunway)}</DeparturePosition>`);
  out(`        <DepartureName>${esc(dep.name ?? dep.ident)}</DepartureName>`);
  out(`        <DestinationName>${esc(dest.name ?? dest.ident)}</DestinationName>`);
  out('        <AppVersion>');
  out('            <AppVersionMajor>11</AppVersionMajor>');
  out('            <AppVersionBuild>282174</AppVersionBuild>');
  out('        </AppVersion>');

  const runwayTags = (runway: string | undefined, indent: string) => {
    if (!runway) return;
    const { number, designator } = splitRunway(runway);
    out(`${indent}<RunwayNumberFP>${number}</RunwayNumberFP>`);
    if (designator) out(`${indent}<RunwayDesignatorFP>${designator}</RunwayDesignatorFP>`);
  };

  wps.forEach((wp, i) => {
    const ind = '            ';
    out(`        <ATCWaypoint id="${esc(plnId(wp, i))}">`);
    out(`${ind}<ATCWaypointType>${TYPE_TO_PLN[wp.type]}</ATCWaypointType>`);
    out(`${ind}<WorldPosition>${formatLla(wp.lat, wp.lon, wp.altFt ?? (wp.type === 'airport' ? 0 : plan.cruiseAltFt))}</WorldPosition>`);
    if (wp.airway) out(`${ind}<ATCAirway>${esc(wp.airway)}</ATCAirway>`);
    if (wp.procedure?.kind === 'sid') {
      out(`${ind}<DepartureFP>${esc(wp.procedure.name)}</DepartureFP>`);
      runwayTags(wp.procedure.runway, ind);
    } else if (wp.procedure?.kind === 'star') {
      out(`${ind}<ArrivalFP>${esc(wp.procedure.name)}</ArrivalFP>`);
      runwayTags(wp.procedure.runway, ind);
    } else if (wp.procedure?.kind === 'approach') {
      const a = parseApproachName(wp.procedure.name);
      if (a) {
        out(`${ind}<ApproachTypeFP>${APPROACH_TYPES[a.type]}</ApproachTypeFP>`);
        runwayTags(a.runway, ind);
        if (a.suffix) out(`${ind}<SuffixFP>${a.suffix}</SuffixFP>`);
      }
    } else if (!expanded && wp === firstEnroute && proc.sid) {
      // Not expanded (no simulator database): tag the SID exit fix so MSFS can still try to find the SID.
      out(`${ind}<DepartureFP>${esc(proc.sid)}</DepartureFP>`);
      runwayTags(proc.departureRunway, ind);
    } else if (!expanded && wp === lastEnroute && proc.star) out(`${ind}<ArrivalFP>${esc(proc.star)}</ArrivalFP>`);
    if (i === 0 && wp.type === 'airport') runwayTags(proc.departureRunway, ind);
    if (i === wps.length - 1 && wp.type === 'airport') {
      if (approach) {
        out(`${ind}<ApproachTypeFP>${APPROACH_TYPES[approach.type]}</ApproachTypeFP>`);
        runwayTags(approach.runway, ind);
        if (approach.suffix) out(`${ind}<SuffixFP>${approach.suffix}</SuffixFP>`);
      } else runwayTags(proc.arrivalRunway, ind);
    }
    if (wp.type !== 'user') {
      out(`${ind}<ICAO>`);
      if (wp.region) out(`${ind}    <ICAORegion>${esc(wp.region)}</ICAORegion>`);
      out(`${ind}    <ICAOIdent>${esc(wp.ident)}</ICAOIdent>`);
      out(`${ind}</ICAO>`);
    }
    out('        </ATCWaypoint>');
  });
  out('    </FlightPlan.FlightPlan>');
  out('</SimBase.Document>');
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- Parsing

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1].trim()) : undefined;
};
const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parsePln(xml: string, source = 'PLN file'): FlightPlan {
  const text = xml.replace(/^﻿/, '');
  if (!/<FlightPlan\.FlightPlan>/i.test(text)) throw new Error('This does not look like an MSFS flight plan (.PLN) file.');
  const procedures: PlanProcedures = {};
  const waypoints: PlanWaypoint[] = [];
  const blocks = text.match(/<ATCWaypoint[\s\S]*?<\/ATCWaypoint>/gi) ?? [];
  for (const block of blocks) {
    const id = /<ATCWaypoint\s+id="([^"]*)"/i.exec(block)?.[1] ?? '';
    if (SIM_PSEUDO_WAYPOINT.test(id)) continue;
    const lla = parseLla(tag(block, 'WorldPosition') ?? '');
    if (!lla) continue;
    const type = PLN_TO_TYPE[(tag(block, 'ATCWaypointType') ?? 'User').toLowerCase()] ?? 'user';
    const runway = joinRunway(tag(block, 'RunwayNumberFP'), tag(block, 'RunwayDesignatorFP'));
    const departure = tag(block, 'DepartureFP');
    const arrival = tag(block, 'ArrivalFP');
    const approachType = tag(block, 'ApproachTypeFP');
    if (departure) {
      procedures.sid = departure;
      if (runway) procedures.departureRunway = runway;
    }
    if (arrival) procedures.star = arrival;
    if (approachType && runway) {
      const short = Object.entries(APPROACH_TYPES).find(([, v]) => v === approachType.toUpperCase())?.[0] ?? approachType;
      const suffix = tag(block, 'SuffixFP');
      procedures.approach = `${short} ${runway}${suffix ? ` ${suffix}` : ''}`;
      procedures.arrivalRunway = runway;
    }
    // Procedure fixes are re-created from the simulator's database when the plan is sent.
    if (type !== 'airport' && (departure || arrival || approachType)) continue;
    const isFirst = waypoints.length === 0;
    if (runway && type === 'airport' && !approachType) {
      if (isFirst) procedures.departureRunway ??= runway;
      else procedures.arrivalRunway = runway;
    }
    waypoints.push({
      id: randomUUID(),
      ident: tag(block, 'ICAOIdent') ?? id,
      type,
      lat: lla.lat,
      lon: lla.lon,
      region: tag(block, 'ICAORegion'),
      airway: tag(block, 'ATCAirway'),
      altFt: type === 'airport' ? lla.altFt : lla.altFt || null,
    });
  }
  if (waypoints.length < 2) throw new Error('The flight plan has fewer than two waypoints.');
  const depPos = tag(text, 'DeparturePosition');
  if (depPos && /^\d{1,2}[LRC]?$/i.test(depPos)) procedures.departureRunway ??= depPos.toUpperCase().padStart(2, '0');
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  if (first.type === 'airport') first.name = tag(text, 'DepartureName');
  if (last.type === 'airport') last.name = tag(text, 'DestinationName');
  return {
    title: tag(text, 'Title') ?? `${first.ident} to ${last.ident}`,
    rules: tag(text, 'FPType')?.toUpperCase() === 'VFR' ? 'VFR' : 'IFR',
    cruiseAltFt: Math.round(Number(tag(text, 'CruisingAlt') ?? 0)) || 5000,
    waypoints,
    procedures,
    source,
    updatedAt: Date.now(),
    sentToSimAt: null,
  };
}
