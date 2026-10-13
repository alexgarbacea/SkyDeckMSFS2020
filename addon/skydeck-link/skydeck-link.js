// SkyDeck Link: runs inside the G1000 NXi MFD (added by SkyDeck's Community package) and lets SkyDeck edit the
// avionics' own flight plan through the NXi's FMS, the same way its knobs and the World Map loader do.
// Plain ES2017, no modules: it is loaded with the MFD's other scripts. Generated port: __SKYDECK_PORT__.
(function () {
  'use strict';
  var VERSION = '__SKYDECK_LINK_VERSION__';
  var BASE_PORT = Number('__SKYDECK_PORT__') || 4500;
  var PORTS = [BASE_PORT];
  for (var p = 4500; p < 4510; p++) if (PORTS.indexOf(p) < 0) PORTS.push(p);
  var AVIONICS = 'G1000 NXi';

  var sdk = window.msfssdk;
  var ws = null;
  var portIndex = 0;
  var lastState = '';
  var lastStateSent = 0;
  var userWptCounter = 1;
  var facilityCache = {};

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[SkyDeck Link]');
    console.log.apply(console, args);
    // Also report to SkyDeck's log file, since the sim's console is hard to reach.
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'log', level: /fail|error|bad/i.test(String(args[1])) ? 'error' : 'info', message: args.slice(1).join(' ') }));
      } catch (e) {
        /* ignore */
      }
    }
  }

  function getInstrument() {
    var el = document.querySelector('wtg1000-mfd');
    return el && el.fms ? el : null;
  }

  function getFms() {
    var mfd = getInstrument();
    return mfd ? mfd.fms : null;
  }

  // ------------------------------------------------------------------ Facilities

  function pad(s, n) {
    s = s || '';
    while (s.length < n) s += ' ';
    return s.substr(0, n);
  }

  function airportIcao(ident) {
    return 'A' + pad('', 2) + pad('', 4) + pad(ident, 5);
  }

  var TYPE_LETTER = { fix: 'W', vor: 'V', ndb: 'N', airport: 'A' };
  var SEARCH_TYPE = { fix: 2, vor: 3, ndb: 4, airport: 1 }; // FacilitySearchType

  function facilityTypeOf(icao) {
    return sdk.ICAO.getFacilityType(icao);
  }

  function getFacility(fms, icao) {
    if (facilityCache[icao]) return Promise.resolve(facilityCache[icao]);
    return fms.facLoader.getFacility(facilityTypeOf(icao), icao).then(function (fac) {
      facilityCache[icao] = fac;
      return fac;
    });
  }

  function distanceNm(lat1, lon1, lat2, lon2) {
    var r = Math.PI / 180;
    var dLat = (lat2 - lat1) * r;
    var dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Finds a navaid/fix facility by ident, preferring the given region and the closest match to lat/lon. */
  function resolveFix(fms, wp) {
    var letter = TYPE_LETTER[wp.type];
    var tryExact = wp.region
      ? getFacility(fms, letter + pad(wp.region, 2) + pad('', 4) + pad(wp.ident, 5)).catch(function () {
          return null;
        })
      : Promise.resolve(null);
    return tryExact.then(function (fac) {
      if (fac) return fac;
      return fms.facLoader.searchByIdent(SEARCH_TYPE[wp.type] || 0, wp.ident, 40).then(function (icaos) {
        var exact = icaos.filter(function (icao) {
          return sdk.ICAO.getIdent(icao) === wp.ident && (letter === undefined || icao[0] === letter);
        });
        return Promise.all(
          exact.map(function (icao) {
            return getFacility(fms, icao).catch(function () {
              return null;
            });
          }),
        ).then(function (facs) {
          var best = null;
          var bestD = Infinity;
          facs.forEach(function (f) {
            if (!f) return;
            var d = distanceNm(wp.lat, wp.lon, f.lat, f.lon);
            if (d < bestD) {
              bestD = d;
              best = f;
            }
          });
          return bestD < 150 ? best : null;
        });
      });
    });
  }

  function userFacility(fms, wp) {
    var icao = 'U' + pad('', 2) + pad('', 4) + pad('USR' + String(userWptCounter++).padStart(2, '0'), 5);
    var fac = sdk.UserFacilityUtils.createFromLatLon(icao, wp.lat, wp.lon, true, wp.ident);
    fms.addUserFacility(fac);
    return fac;
  }

  // ------------------------------------------------------------------ Procedures

  function runwayName(number, designator) {
    return sdk.RunwayUtils.getRunwayNameString(number, designator);
  }

  function findIndex(list, pred) {
    for (var i = 0; i < (list || []).length; i++) if (pred(list[i], i)) return i;
    return -1;
  }

  function oneWayRunway(fac, runway) {
    return runway ? sdk.RunwayUtils.matchOneWayRunwayFromDesignation(fac, runway) : undefined;
  }

  function procedureIndexes(proc, runway, transition) {
    var rwyIdx = runway
      ? findIndex(proc.runwayTransitions, function (rt) {
          return runwayName(rt.runwayNumber, rt.runwayDesignation) === runway;
        })
      : -1;
    // Procedures without runway transitions still expect index 0 (see the NXi's own loader).
    if (rwyIdx < 0 && proc.runwayTransitions && proc.runwayTransitions.length === 1) rwyIdx = 0;
    var enrIdx = transition
      ? findIndex(proc.enRouteTransitions, function (t) {
          return t.name === transition;
        })
      : -1;
    return { runway: rwyIdx, transition: enrIdx };
  }

  // ------------------------------------------------------------------ Loading a plan

  function loadPlan(data) {
    var fms = getFms();
    if (!fms) return Promise.reject(new Error('The G1000 NXi is not ready yet.'));
    var report = [];
    var originFac = null;
    var destFac = null;
    return fms
      .emptyPrimaryFlightPlan()
      .then(function () {
        return Promise.all([
          data.origin ? getFacility(fms, airportIcao(data.origin.ident)).catch(function () { return null; }) : null,
          data.destination ? getFacility(fms, airportIcao(data.destination.ident)).catch(function () { return null; }) : null,
        ]);
      })
      .then(function (facs) {
        originFac = facs[0];
        destFac = facs[1];
        var plan = fms.getPrimaryFlightPlan();

        // Origin and SID
        if (originFac) {
          var depRunway = data.origin.runway;
          var depIdx = data.departure
            ? findIndex(originFac.departures, function (d) {
                return d.name === data.departure.name;
              })
            : -1;
          if (data.departure && depIdx < 0) report.push('SID ' + data.departure.name + ' not found in the NXi database');
          if (depIdx >= 0) {
            var dep = originFac.departures[depIdx];
            var di = procedureIndexes(dep, data.departure.runway || depRunway, data.departure.transition);
            fms.insertDeparture(originFac, depIdx, di.runway, di.transition, oneWayRunway(originFac, data.departure.runway || depRunway));
          } else {
            fms.setOrigin(originFac, oneWayRunway(originFac, depRunway));
          }
        } else if (data.origin) {
          report.push('Origin ' + data.origin.ident + ' not found');
        }

        // Destination, STAR, approach
        var destDone = Promise.resolve();
        if (destFac) {
          var arrIdx = data.arrival
            ? findIndex(destFac.arrivals, function (a) {
                return a.name === data.arrival.name;
              })
            : -1;
          if (data.arrival && arrIdx < 0) report.push('STAR ' + data.arrival.name + ' not found in the NXi database');
          if (arrIdx >= 0) {
            var arr = destFac.arrivals[arrIdx];
            var ai = procedureIndexes(arr, data.arrival.runway, data.arrival.transition);
            fms.insertArrival(destFac, arrIdx, ai.runway, ai.transition, oneWayRunway(destFac, data.arrival.runway));
          }
          var appIdx = -1;
          if (data.approach) {
            var a = data.approach;
            appIdx = findIndex(destFac.approaches, function (ap) {
              return (
                ap.approachType === a.type &&
                ap.runwayNumber === a.runwayNumber &&
                ap.runwayDesignator === a.runwayDesignator &&
                (ap.approachSuffix || '').trim() === (a.suffix || '')
              );
            });
            if (appIdx < 0) report.push('Approach ' + a.name + ' not found in the NXi database');
          }
          if (appIdx >= 0) {
            var approach = destFac.approaches[appIdx];
            var transIdx = data.approach.transition
              ? findIndex(approach.transitions, function (t) {
                  return t.name === data.approach.transition;
                })
              : -1;
            destDone = fms.insertApproach(destFac, appIdx, transIdx);
          } else if (arrIdx < 0) {
            fms.setDestination(destFac, oneWayRunway(destFac, data.destination.runway));
          }
        } else if (data.destination) {
          report.push('Destination ' + data.destination.ident + ' not found');
        }

        // Enroute waypoints, resolved one by one so they keep their order.
        return destDone.then(function () {
          var lastDepartureIcao;
          var depSeg = plan.getSegment(0);
          if (depSeg && depSeg.legs.length > 1) lastDepartureIcao = depSeg.legs[depSeg.legs.length - 1].leg.fixIcao;
          var chain = Promise.resolve();
          (data.enroute || []).forEach(function (wp) {
            chain = chain.then(function () {
              var facPromise = wp.type === 'user' ? Promise.resolve(userFacility(fms, wp)) : resolveFix(fms, wp);
              return facPromise.then(function (fac) {
                if (!fac) {
                  report.push(wp.ident + ' not found, skipped');
                  return;
                }
                if (fac.icao === lastDepartureIcao) return;
                var enrouteIndex = findEnrouteSegment(plan);
                fms.insertWaypoint(enrouteIndex, fac);
              });
            });
          });
          return chain;
        });
      })
      .then(function () {
        var plan = fms.getPrimaryFlightPlan();
        return plan.calculate(0).then(function () {
          var grounded = typeof Simplane !== 'undefined' && Simplane.getIsGrounded();
          if (grounded) plan.setLateralLeg(0);
          else fms.activateNearestLeg();
          return { legs: plan.length, warnings: report };
        });
      });
  }

  /** The last enroute segment, where new waypoints go (before the arrival/approach). */
  function findEnrouteSegment(plan) {
    var idx = 1;
    for (var i = 0; i < plan.segmentCount; i++) {
      if (plan.getSegment(i).segmentType === sdk.FlightPlanSegmentType.Enroute) idx = i;
    }
    return idx;
  }

  function directTo(target) {
    var fms = getFms();
    if (!fms) return Promise.reject(new Error('The G1000 NXi is not ready yet.'));
    var plan = fms.getPrimaryFlightPlan();
    // In the plan already? Fly direct to that leg.
    for (var s = 0; s < plan.segmentCount; s++) {
      var seg = plan.getSegment(s);
      for (var l = 0; l < seg.legs.length; l++) {
        var icao = seg.legs[l].leg.fixIcao;
        if (icao && sdk.ICAO.getIdent(icao) === target.ident) {
          fms.createDirectToExisting(s, l);
          return Promise.resolve({ inPlan: true });
        }
      }
    }
    var facPromise = target.type === 'user' ? Promise.resolve(userFacility(fms, target)) : target.type === 'airport' ? getFacility(fms, airportIcao(target.ident)) : resolveFix(fms, target);
    return facPromise.then(function (fac) {
      if (!fac) throw new Error(target.ident + ' was not found in the NXi database.');
      fms.createDirectToRandom(fac);
      return { inPlan: false };
    });
  }

  // ------------------------------------------------------------------ Reporting

  function procedureName(fac, kind, index) {
    if (!fac || index < 0) return null;
    if (kind === 'approach') {
      var ap = fac.approaches[index];
      if (!ap) return null;
      try {
        return window.garminsdk.FmsUtils.getApproachNameAsString(ap);
      } catch (e) {
        return ap.name;
      }
    }
    var p = (kind === 'departure' ? fac.departures : fac.arrivals)[index];
    return p ? p.name : null;
  }

  function collectState() {
    var fms = getFms();
    if (!fms) return Promise.resolve({ ready: false });
    var plan = fms.getPrimaryFlightPlan();
    var legs = [];
    for (var s = 0; s < plan.segmentCount; s++) {
      var seg = plan.getSegment(s);
      for (var l = 0; l < seg.legs.length && legs.length < 300; l++) {
        var leg = seg.legs[l];
        var calc = leg.calculated;
        legs.push({ ident: leg.name || '', lat: calc ? calc.endLat : null, lon: calc ? calc.endLon : null });
      }
    }
    var d = plan.procedureDetails;
    var lookups = [plan.originAirport ? getFacility(fms, plan.originAirport).catch(function () { return null; }) : null, plan.destinationAirport ? getFacility(fms, plan.destinationAirport).catch(function () { return null; }) : null];
    return Promise.all(lookups).then(function (facs) {
      var arrFac = d.arrivalFacilityIcao && facs[1] && facs[1].icao !== d.arrivalFacilityIcao ? null : facs[1];
      var appFac = d.approachFacilityIcao && facs[1] && facs[1].icao !== d.approachFacilityIcao ? null : facs[1];
      return {
        ready: true,
        origin: plan.originAirport ? sdk.ICAO.getIdent(plan.originAirport) : null,
        destination: plan.destinationAirport ? sdk.ICAO.getIdent(plan.destinationAirport) : null,
        departure: procedureName(facs[0], 'departure', d.departureIndex),
        arrival: procedureName(arrFac, 'arrival', d.arrivalIndex),
        approach: procedureName(appFac, 'approach', d.approachIndex),
        activeLeg: plan.activeLateralLeg,
        legs: legs,
      };
    });
  }

  function sendState(force) {
    if (!ws || ws.readyState !== 1) return;
    collectState()
      .then(function (state) {
        var json = JSON.stringify(state);
        var now = Date.now();
        if (!force && json === lastState && now - lastStateSent < 15000) return;
        lastState = json;
        lastStateSent = now;
        send({ type: 'state', state: state });
      })
      .catch(function (e) {
        log('state failed', e && e.message);
      });
  }

  // ------------------------------------------------------------------ Connection to SkyDeck

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function handle(msg) {
    var work;
    if (msg.type === 'loadPlan') work = loadPlan(msg.plan);
    else if (msg.type === 'directTo') work = directTo(msg.target);
    else if (msg.type === 'refresh') {
      sendState(true);
      return;
    } else return;
    work
      .then(function (result) {
        send({ type: 'result', id: msg.id, ok: true, result: result });
        setTimeout(function () {
          sendState(true);
        }, 1500);
      })
      .catch(function (e) {
        log('request failed', e && e.stack);
        send({ type: 'result', id: msg.id, ok: false, message: (e && e.message) || String(e) });
      });
  }

  function connect() {
    var port = PORTS[portIndex % PORTS.length];
    var socket;
    try {
      socket = new WebSocket('ws://127.0.0.1:' + port + '/link');
    } catch (e) {
      retry();
      return;
    }
    var opened = false;
    socket.onopen = function () {
      opened = true;
      ws = socket;
      log('connected to SkyDeck on port', port);
      send({ type: 'hello', avionics: AVIONICS, version: VERSION, ready: !!getFms() });
      sendState(true);
    };
    socket.onmessage = function (ev) {
      try {
        handle(JSON.parse(ev.data));
      } catch (e) {
        log('bad message', e && e.message);
      }
    };
    socket.onclose = function () {
      if (ws === socket) ws = null;
      if (!opened) portIndex++;
      retry();
    };
    socket.onerror = function () {
      /* onclose follows */
    };
  }

  function retry() {
    // Cycle quickly through candidate ports, then back off while SkyDeck is not running.
    setTimeout(connect, portIndex % PORTS.length === 0 ? 5000 : 300);
  }

  setInterval(function () {
    sendState(false);
  }, 3000);

  // Wait until the MFD instrument exists before connecting.
  var waitForFms = setInterval(function () {
    if (!sdk) sdk = window.msfssdk;
    if (sdk && getFms()) {
      clearInterval(waitForFms);
      log('G1000 NXi found, version ' + VERSION);
      connect();
    }
  }, 1000);
})();
