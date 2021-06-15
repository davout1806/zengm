import flatten from "lodash-es/flatten";
import {
	filterPlayerStats,
	PLAYER_GAME_STATS,
	processPlayerStats,
} from "../../common";
import type { UpdateEvents, ViewInput } from "../../common/types";
import { idb } from "../db";
import { g, getTeamInfoBySeason } from "../util";
import { getCommon } from "./player";

const updatePlayerGameLog = async (
	{ pid, season }: ViewInput<"playerGameLog">,
	updateEvents: UpdateEvents,
	state: any,
) => {
	if (
		updateEvents.includes("firstRun") ||
		state.pid !== pid ||
		state.season !== season ||
		state.season === g.get("season")
	) {
		const topStuff = await getCommon(pid);

		if (topStuff.type === "error") {
			// https://stackoverflow.com/a/59923262/786644
			const returnValue = {
				errorMessage: topStuff.errorMessage,
			};
			return returnValue;
		}

		const seasonsWithStats = Array.from(
			new Set(
				topStuff.player.stats.filter(row => row.gp > 0).map(row => row.season),
			),
		).reverse();

		const superCols = [
			{
				title: "",
				colspan: 4,
			},
		];
		const stats: string[] = [];

		const allStats = Array.from(
			new Set(flatten(Object.values(PLAYER_GAME_STATS).map(x => x.stats))),
		);

		const games = await idb.getCopies.games({ season });

		const abbrevsByTid: Record<number, string> = {};
		const getAbbrev = async (tid: number) => {
			let abbrev = abbrevsByTid[tid];
			if (abbrev === undefined) {
				const info = await getTeamInfoBySeason(tid, season);
				abbrev = info?.abbrev ?? "???";
				abbrevsByTid[tid] = abbrev;
			}
			return abbrev;
		};

		const gameLog = [];
		for (const game of games) {
			let row = game.teams[0].players.find(p => p.pid === pid);
			let t0 = 0;
			if (!row) {
				row = game.teams[1].players.find(p => p.pid === pid);
				t0 = 1;
			}
			if (!row) {
				continue;
			}

			const t1 = t0 === 0 ? 1 : 0;

			let result;
			if (game.teams[t0].pts > game.teams[t1].pts) {
				result = "W";
			} else if (game.teams[t0].pts < game.teams[t1].pts) {
				result = "L";
			} else {
				result = "T";
			}

			let overtimes = "";
			if (game.overtimes !== undefined && game.overtimes > 0) {
				if (game.overtimes === 1) {
					overtimes = " OT";
				} else if (game.overtimes > 1) {
					overtimes = ` ${game.overtimes}OT`;
				}
			}

			const processed = processPlayerStats(row, allStats);
			const p = {
				...row,
				processed,
			};

			const types = [];
			for (const [type, { stats }] of Object.entries(PLAYER_GAME_STATS)) {
				if (filterPlayerStats(p, stats, type)) {
					types.push(type);
				}
			}
			if (types.length === 0) {
				continue;
			}

			const tid = game.teams[t0].tid;
			const oppTid = game.teams[t1].tid;

			const abbrev = await getAbbrev(tid);
			const oppAbbrev = await getAbbrev(oppTid);

			const gameStats: Record<string, number> = {};
			for (const type of types) {
				const info = PLAYER_GAME_STATS[type];

				// Filter gets rid of dupes, like how fmbLost appears for both Passing and Rushing in FBGM
				const newStats = info.stats.filter(stat => !stats.includes(stat));

				if (newStats.length > 0) {
					stats.push(...newStats);
					superCols.push({
						title: info.name,
						colspan: newStats.length,
					});
				}

				for (const stat of info.stats) {
					gameStats[stat] = p.processed[stat];
				}
			}

			gameLog.push({
				tid,
				abbrev,
				oppTid,
				oppAbbrev,
				result: `${result} (${game.teams[t0].pts}-${game.teams[t1].pts}${overtimes})`,
				playoffs: game.playoffs,
				stats: gameStats,
			});
		}

		console.log(superCols, stats, games, gameLog);

		return {
			...topStuff,
			gameLog,
			season,
			seasonsWithStats,
			stats,
			superCols: superCols.length > 2 ? superCols : undefined,
		};
	}
};

export default updatePlayerGameLog;
