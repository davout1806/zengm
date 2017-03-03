// @flow

import _ from 'underscore';
import {PHASE, PHASE_TEXT, PLAYER, g, helpers} from '../../common';
import {finances, league, phase, player} from '../core';
import {getCopy, idb} from '../db';
import {logEvent, random, updatePlayMenu, updatePhase} from '../util';
import type {PickRealized, TeamFiltered} from '../../common/types';

// Add a new set of draft picks
async function genPicks(season: number) {
    for (let tid = 0; tid < g.numTeams; tid++) {
        for (let round = 1; round <= 2; round++) {
            await idb.cache.add('draftPicks', {
                tid,
                originalTid: tid,
                round,
                season,
            });
        }
    }
}

/**
 * Retrieve the current remaining draft order.
 *
 * @memberOf core.draft
 * @return {Promise} Resolves to an ordered array of pick objects.
 */
async function getOrder() {
    const row = await idb.cache.get('draftOrder', 0);
    return row.draftOrder;
}

/**
 * Generate a set of draft prospects.
 *
 * This is called after draft classes are moved up a year, to create the new UNDRAFTED_3 class. It's also called 3 times when a new league starts, to create all 3 draft classes.
 *
 * @memberOf core.draft
 * @param {number} tid Team ID number for the generated draft class. Should be PLAYER.UNDRAFTED, PLAYER.UNDRAFTED_2, or PLAYER.UNDRAFTED_3.
 * @param {?number=} scoutingRank Between 1 and g.numTeams, the rank of scouting spending, probably over the past 3 years via core.finances.getRankLastThree. If null, then it's automatically found.
 * @param {?number=} numPlayers The number of prospects to generate. Default value is 70.
 * @return {Promise}
 */
async function genPlayers(tid: number, scoutingRank?: ?number = null, numPlayers?: number, newLeague?: boolean = false) {
    if (numPlayers === null || numPlayers === undefined) {
        numPlayers = Math.round(70 * g.numTeams / 30); // 70 scaled by number of teams
    }

    // If scoutingRank is not supplied, have to hit the DB to get it
    if (scoutingRank === undefined || scoutingRank === null) {
        const teamSeasons = await idb.cache.indexGetAll('teamSeasonsByTidSeason', [`${g.userTid},${g.season - 2}`, `${g.userTid},${g.season}`]);
        scoutingRank = finances.getRankLastThree(teamSeasons, "expenses", "scouting");
    }

    const profiles = ["Point", "Wing", "Big", "Big", ""];

    for (let i = 0; i < numPlayers; i++) {
        const baseRating = random.randInt(8, 31);
        const pot = Math.round(helpers.bound(random.realGauss(48, 17), baseRating, 90));

        const profile = profiles[random.randInt(0, profiles.length - 1)];
        const agingYears = random.randInt(0, 3);
        let draftYear = g.season;

        let baseAge = 19;
        if (newLeague) {
            // New league, creating players for draft in same season and following 2 seasons
            if (tid === PLAYER.UNDRAFTED_2) {
                baseAge -= 1;
                draftYear += 1;
            } else if (tid === PLAYER.UNDRAFTED_3) {
                baseAge -= 2;
                draftYear += 2;
            }
        } else if (tid === PLAYER.UNDRAFTED_3) {
            // Player being generated after draft ends, for draft in 3 years
            baseAge -= 3;
            draftYear += 3;
        }

        const p = player.generate(tid, baseAge, profile, baseRating, pot, draftYear, false, scoutingRank);
        player.develop(p, agingYears, true);

        // Update player values after ratings changes
        await player.updateValues(p);
        await idb.cache.add('players', p);
    }
}

function lotteryLogTxt(tid: number, type: 'chance' | 'moveddown' | 'movedup' | 'normal', number: number) {
    let txt = `The <a href="${helpers.leagueUrl(["roster", g.teamAbbrevsCache[tid], g.season])}">${g.teamNamesCache[tid]}</a>`;
    if (type === 'chance') {
        txt += ` have a ${number.toFixed(2)}% chance of getting the top overall pick of the ${g.season} draft.`;
    } else if (type === 'movedup') {
        txt += ` moved up in the lottery and will select ${helpers.ordinal(number)} overall in the ${g.season} draft.`;
    } else if (type === 'moveddown') {
        txt += ` moved down in the lottery and will select ${helpers.ordinal(number)} overall in the ${g.season} draft.`;
    } else if (type === 'normal') {
        txt += ` will select ${helpers.ordinal(number)} overall in the ${g.season} draft.`;
    }
    return txt;
}

function logAction(tid: number, text: string) {
    logEvent({
        type: "draft",
        text,
        showNotification: tid === g.userTid,
        pids: [],
        tids: [tid],
    });
}

function logLotteryChances(chances: number[], teams: TeamFiltered[], draftOrder) {
    for (let i = 0; i < chances.length; i++) {
        if (i < teams.length) {
            const origTm = teams[i].tid;
            const tm = draftOrder[origTm][1].tid;
            const txt = lotteryLogTxt(tm, 'chance', chances[i]);
            logAction(tm, txt);
        }
    }
}

function logLotteryWinners(chances: number[], teams: TeamFiltered[], tm: number, origTm: number, pick: number) {
    const idx = teams.find(t => t.tid === origTm);
    if (idx !== undefined) {
        let txt;
        if (chances[idx] < chances[pick - 1]) {
            txt = lotteryLogTxt(tm, 'movedup', pick);
        } else if (chances[idx] > chances[pick - 1]) {
            txt = lotteryLogTxt(tm, 'moveddown', pick);
        } else {
            txt = lotteryLogTxt(tm, 'normal', pick);
        }
        logAction(tm, txt);
    }
}

/**
 * Divide the combinations between teams with tied records.
 *
 * If isFinal is true, the remainder value is distributed randomly instead
 * of being set as a decimal value on the result.
 */
function updateChances(chances: number[], teams: TeamFiltered[], isFinal?: boolean = false) {
    let wps = _.countBy(teams, (t) => t.seasonAttrs.winp);
    wps = _.pairs(wps);
    wps = _.sortBy(wps, x => Number(x[0]));
    let tc = 0;

    for (let k = 0; k < wps.length; k++) {
        let val = wps[k][1];
        if (val > 1) {
            if (tc + val >= chances.length) {
                val -= (tc + val - chances.length);
                // Do not exceed 14, as the chances are only for lottery teams.
            }
            const total = chances.slice(tc, tc + val).reduce((a, b) => a + b);
            let remainder = (isFinal) ? total % val : 0;
            const newVal = (total - remainder) / val;

            let i;
            let j;
            for (i = tc, j = tc + val; i < j; i++) {
                chances[i] = newVal;
                if (remainder > 0) {
                    chances[i] += 1;
                    remainder--;
                }
            }
        }
        tc += val;
        if (tc >= chances.length) {
            break;
        }
    }
}

/**
 * Sort teams in place in correct order for lottery.
 *
 * Sort teams by making playoffs (NOT playoff performance) and winp, for first round
 */
function lotterySort(teams: TeamFiltered[]) {
    /**
     * http://www.nba.com/2015/news/04/17/2015-draft-order-of-selection-tiebreak-official-release/index.html
     *
     * The tiebreaker used after the lottery is random. Which is then reversed for the 2nd round.
     */
    const randValues = _.range(g.numTeams);
    random.shuffle(randValues);
    for (let i = 0; i < teams.length; i++) {
        teams[i].randVal = randValues[i];
    }

    teams.sort((a, b) => {
        let r;
        r = 0;
        if ((a.seasonAttrs.playoffRoundsWon >= 0) && !(b.seasonAttrs.playoffRoundsWon >= 0)) {
            r = 1;
        }
        if (!(a.seasonAttrs.playoffRoundsWon >= 0) && (b.seasonAttrs.playoffRoundsWon >= 0)) {
            r = -1;
        }

        r = (r === 0) ? a.seasonAttrs.winp - b.seasonAttrs.winp : r;
        r = (r === 0) ? a.randVal - b.randVal : r;
        return r;
    });
}

/**
 * Sets draft order and save it to the draftOrder object store.
 *
 * This is currently based on an NBA-like lottery, where the first 3 picks can be any of the non-playoff teams (with weighted probabilities).
 *
 * @memberOf core.draft
 * @return {Promise}
 */
async function genOrder() {
    const teams = await getCopy.teams({
        attrs: ["tid", "cid"],
        seasonAttrs: ["winp", "playoffRoundsWon"],
        season: g.season,
    });

    // Draft lottery
    lotterySort(teams);
    const chances = [250, 199, 156, 119, 88, 63, 43, 28, 17, 11, 8, 7, 6, 5];
    updateChances(chances, teams, true);

    const chanceTotal = chances.reduce((a, b) => a + b);
    const chancePct = chances.map(c => (c / chanceTotal) * 100);

    // cumsum
    for (let i = 1; i < chances.length; i++) {
        chances[i] += chances[i - 1];
    }
    // Pick first three picks based on chances
    const firstThree = [];
    while (firstThree.length < 3) {
        const draw = random.randInt(0, 999);
        const i = chances.findIndex(chance => chance > draw);
        if (!firstThree.includes(i)) {
            // If one lottery winner, select after other tied teams;
            teams[i].randVal -= 30;
            firstThree.push(i);
        }
    }

    let draftPicks = await idb.cache.indexGetAll('draftPicksBySeason', g.season);

    // Sometimes picks just fail to generate, for reasons I don't understand
    if (draftPicks.length === 0) {
        await genPicks(g.season);
        draftPicks = await idb.cache.indexGetAll('draftPicksBySeason', g.season);
    }

    // Reorganize this to an array indexed on originalTid and round
    const draftPicksIndexed = [];
    for (let i = 0; i < draftPicks.length; i++) {
        const tid = draftPicks[i].originalTid;
        // Initialize to an array
        if (draftPicksIndexed.length < tid || draftPicksIndexed[tid] === undefined) {
            draftPicksIndexed[tid] = [];
        }
        draftPicksIndexed[tid][draftPicks[i].round] = {
            tid: draftPicks[i].tid,
        };
    }

    logLotteryChances(chancePct, teams, draftPicksIndexed);

    const draftOrder = [];

    // First round - lottery winners
    for (let i = 0; i < firstThree.length; i++) {
        const tid = draftPicksIndexed[teams[firstThree[i]].tid][1].tid;
        draftOrder.push({
            round: 1,
            pick: i + 1,
            tid,
            originalTid: teams[firstThree[i]].tid,
        });

        logLotteryWinners(chancePct, teams, tid, teams[firstThree[i]].tid, i + 1);
    }

    // First round - everyone else
    let pick = 4;
    for (let i = 0; i < teams.length; i++) {
        if (!firstThree.includes(i)) {
            const tid = draftPicksIndexed[teams[i].tid][1].tid;
            draftOrder.push({
                round: 1,
                pick,
                tid,
                originalTid: teams[i].tid,
            });

            if (pick < 15) {
                logLotteryWinners(chancePct, teams, tid, teams[i].tid, pick);
            }

            pick += 1;
        }
    }

    // Sort by winp with reverse randVal for tiebreakers.
    teams.sort((a, b) => {
        const r = a.seasonAttrs.winp - b.seasonAttrs.winp;
        return (r === 0) ? b.randVal - a.randVal : r;
    });

    // Second round
    for (let i = 0; i < teams.length; i++) {
        const tid = draftPicksIndexed[teams[i].tid][2].tid;
        draftOrder.push({
            round: 2,
            pick: i + 1,
            tid,
            originalTid: teams[i].tid,
        });
    }

    // Delete from draftPicks object store so that they are completely untradeable
    for (const dp of draftPicks) {
        await idb.cache.delete('draftPicks', dp.dpid);
    }

    await idb.cache.put('draftOrder', {
        rid: 0,
        draftOrder,
    });
}

/**
 * Sets fantasy draft order and save it to the draftOrder object store.
 *
 * Randomize team order and then snake for 12 rounds.
 *
 * @memberOf core.draft
 * @return {Promise}
 */
async function genOrderFantasy(position: number) {
    // Randomly-ordered list of tids
    const tids = _.range(g.numTeams);
    random.shuffle(tids);
    if (position !== undefined && position >= 1 && position <= g.numTeams) {
        let i = 0;
        while (tids[position - 1] !== g.userTid && i < 1000) {
            random.shuffle(tids);
            i += 1;
        }
    }

    // Set total draft order: 12 rounds, snake
    const draftOrder = [];
    for (let round = 1; round <= 12; round++) {
        for (let i = 0; i < tids.length; i++) {
            draftOrder.push({
                round,
                pick: i + 1,
                tid: tids[i],
                originalTid: tids[i],
            });
        }

        tids.reverse(); // Snake
    }

    await idb.cache.put('draftOrder', {
        rid: 0,
        draftOrder,
    });
}

/**
 * Get a list of rookie salaries for all players in the draft.
 *
 * By default there are 60 picks, but some are added/removed if there aren't 30 teams.
 *
 * @memberOf core.draft
 * @return {Array.<number>} Array of salaries, in thousands of dollars/year.
 */
function getRookieSalaries(): number[] {
    // Default for 60 picks
    const rookieSalaries = [5000, 4500, 4000, 3500, 3000, 2750, 2500, 2250, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200, 1100, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500];

    while (g.numTeams * 2 > rookieSalaries.length) {
        // Add min contracts on to end
        rookieSalaries.push(500);
    }
    while (g.numTeams * 2 < rookieSalaries.length) {
        // Remove smallest salaries
        rookieSalaries.pop();
    }

    if (g.minContract !== 500 || g.maxContract !== 20000) {
        for (let i = 0; i < rookieSalaries.length; i++) {
            // Subtract min
            rookieSalaries[i] -= 500;

            // Scale so max will be 1/4 the max contract
            rookieSalaries[i] *= (0.25 * g.maxContract - g.minContract) / (4500);

            // Add min back
            rookieSalaries[i] += g.minContract;

            rookieSalaries[i] = Math.round(rookieSalaries[i] / 10) * 10;
        }
    }

    return rookieSalaries;
}

/**
 * Select a player for the current drafting team.
 *
 * This can be called in response to the user clicking the "draft" button for a player, or by some other function like untilUserOrEnd.
 *
 * @memberOf core.draft
 * @param {object} pick Pick object, like from getOrder, that contains information like the team, round, etc.
 * @param {number} pid Integer player ID for the player to be drafted.
 * @return {Promise}
 */
async function selectPlayer(pick: PickRealized, pid: number) {
    const p = await idb.cache.get('players', pid);

    // Draft player
    p.tid = pick.tid;
    if (g.phase !== PHASE.FANTASY_DRAFT) {
        p.draft = {
            round: pick.round,
            pick: pick.pick,
            tid: pick.tid,
            year: g.season,
            originalTid: pick.originalTid,
            pot: p.ratings[0].pot,
            ovr: p.ratings[0].ovr,
            skills: p.ratings[0].skills,
        };
    }

    // Contract
    if (g.phase !== PHASE.FANTASY_DRAFT) {
        const rookieSalaries = getRookieSalaries();
        const i = pick.pick - 1 + g.numTeams * (pick.round - 1);
        const years = 4 - pick.round; // 2 years for 2nd round, 3 years for 1st round;
        player.setContract(p, {
            amount: rookieSalaries[i],
            exp: g.season + years,
        }, true);
    }

    // Add stats row if necessary (fantasy draft in ongoing season)
    if (g.phase === PHASE.FANTASY_DRAFT && g.nextPhase <= PHASE.PLAYOFFS) {
        await player.addStatsRow(p, g.nextPhase === PHASE.PLAYOFFS);
    }

    idb.cache.markDirtyIndexes('players');

    const draftName = g.phase === PHASE.FANTASY_DRAFT ? `${g.season} fantasy draft` : `${g.season} draft`;
    logEvent({
        type: "draft",
        text: `The <a href="${helpers.leagueUrl(["roster", g.teamAbbrevsCache[pick.tid], g.season])}">${g.teamNamesCache[pick.tid]}</a> selected <a href="${helpers.leagueUrl(["player", p.pid])}">${p.firstName} ${p.lastName}</a> with the ${helpers.ordinal(pick.pick + (pick.round - 1) * 30)} pick in the <a href="${helpers.leagueUrl(["draft_summary", g.season])}">${draftName}</a>.`,
        showNotification: false,
        pids: [p.pid],
        tids: [p.tid],
    });
}

/**
 * Simulate draft picks until it's the user's turn or the draft is over.
 *
 * This could be made faster by passing a transaction around, so all the writes for all the picks are done in one transaction. But when calling selectPlayer elsewhere (i.e. in testing or in response to the user's pick), it needs to be sure that the transaction is complete before continuing. So I would need to create a special case there to account for it. Given that this isn't really *that* slow now, that probably isn't worth the complexity. Although... team.rosterAutoSort does precisely this... so maybe it would be a good idea...
 *
 * @memberOf core.draft
 * @return {Promise.[Array.<Object>, Array.<number>]} Resolves to array. First argument is the list of draft picks (from getOrder). Second argument is a list of player IDs who were drafted during this function call, in order.
 */
async function untilUserOrEnd() {
    const pids = [];

    const [playersAll, draftOrder] = await Promise.all([
        idb.cache.indexGetAll('playersByTid', PLAYER.UNDRAFTED),
        getOrder(),
    ]);

    playersAll.sort((a, b) => b.value - a.value);

    // Called after either the draft is over or it's the user's pick
    const afterDoneAuto = async () => {
        // Is draft over?;
        if (draftOrder.length === 0) {
            // Fantasy draft special case!
            if (g.phase === PHASE.FANTASY_DRAFT) {
                await idb.league.tx(["players", "teamSeasons"], "readwrite", async tx => {
                    // Undrafted players become free agents
                    const baseMoods = await player.genBaseMoods();
                    await tx.players.index('tid').iterate(PLAYER.UNDRAFTED, (p) => {
                        player.addToFreeAgents(p, PHASE.FREE_AGENCY, baseMoods);
                    });

                    // Swap back in normal draft class
                    await tx.players.index('tid').iterate(PLAYER.UNDRAFTED_FANTASY_TEMP, p => {
                        p.tid = PLAYER.UNDRAFTED;
                        return p;
                    });
                });

                await league.setGameAttributes({
                    phase: g.nextPhase,
                    nextPhase: null,
                });

                updatePhase(`${g.season} ${PHASE_TEXT[g.phase]}`);
                await updatePlayMenu();
                league.updateLastDbChange();
            } else {
                // Non-fantasy draft
                await phase.newPhase(PHASE.AFTER_DRAFT);
            }
        } else {
            // Draft is not over, so continue
            league.updateLastDbChange();
        }

        return pids;
    };

    // This will actually draft "untilUserOrEnd"
    const autoSelectPlayer = async () => {
        if (draftOrder.length > 0) {
            const pick = draftOrder.shift();

            if (g.userTids.includes(pick.tid) && g.autoPlaySeasons === 0) {
                draftOrder.unshift(pick);
                return afterDoneAuto();
            }

            const selection = Math.floor(Math.abs(random.gauss(0, 2))); // 0=best prospect, 1=next best prospect, etc.
            const pid = playersAll[selection].pid;
            await selectPlayer(pick, pid);
            pids.push(pid);
            playersAll.splice(selection, 1); // Delete from the list of undrafted players

            return autoSelectPlayer();
        }

        return afterDoneAuto();
    };

    return autoSelectPlayer();
}

export {
    genPicks,
    getOrder,
    genPlayers,
    genOrder,
    genOrderFantasy,
    untilUserOrEnd,
    getRookieSalaries,
    selectPlayer,
    updateChances,
    lotterySort,
};
