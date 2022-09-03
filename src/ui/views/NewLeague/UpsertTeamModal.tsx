import { useEffect, useState } from "react";
import { DEFAULT_JERSEY, DEFAULT_STADIUM_CAPACITY } from "../../../common";
import type { Conf, Div, View } from "../../../common/types";
import Modal from "../../components/Modal";
import { helpers, logEvent } from "../../util";
import TeamForm from "../ManageTeams/TeamForm";
import type { AddEditTeamInfo } from "./CustomizeTeams";
import type { NewLeagueTeamWithoutRank } from "./types";

export const getGodModeWarnings = ({
	is,
	t,
	godModeLimits,
}: {
	is?: boolean;
	t?: {
		pop: string;
		stadiumCapacity: string;
	};
	godModeLimits: View<"newLeague">["godModeLimits"];
}) => {
	const pop = t ? parseFloat(t.pop) : NaN;
	const stadiumCapacity = t ? parseInt(t.stadiumCapacity) : NaN;

	const errors = [];
	if (!Number.isNaN(pop) && pop > godModeLimits.pop) {
		errors.push(
			`a region's population ${is ? "is " : ""}over ${
				godModeLimits.pop
			} million`,
		);
	}
	if (
		!Number.isNaN(stadiumCapacity) &&
		stadiumCapacity > godModeLimits.stadiumCapacity
	) {
		errors.push(
			`a team's stadium capacity ${
				is ? "is " : ""
			}over ${helpers.numberWithCommas(godModeLimits.stadiumCapacity)}`,
		);
	}

	return errors;
};

const GodModeWarning = ({
	controlledTeam,
	godModeLimits,
}: {
	controlledTeam?: {
		pop: string;
		stadiumCapacity: string;
	};
	godModeLimits: View<"newLeague">["godModeLimits"];
}) => {
	const errors = getGodModeWarnings({ t: controlledTeam, godModeLimits });
	if (errors.length >= 1) {
		return (
			<div className="alert alert-danger mb-0">
				If {errors.join(" or ")}, then you will not earn any achievements in
				this league.
			</div>
		);
	}

	return null;
};

const UpsertTeamModal = ({
	addEditTeamInfo,
	teams,
	confs,
	divs,
	onCancel,
	onSave,
	godModeLimits,
}: {
	addEditTeamInfo: AddEditTeamInfo;
	teams: NewLeagueTeamWithoutRank[];
	confs: Conf[];
	divs: Div[];
	onCancel: () => void;
	onSave: (t: NewLeagueTeamWithoutRank) => void;
	godModeLimits: View<"newLeague">["godModeLimits"];
}) => {
	const [controlledTeam, setControlledTeam] = useState<
		| {
				tid: number;
				region: string;
				name: string;
				abbrev: string;
				pop: string;
				stadiumCapacity: string;
				colors: [string, string, string];
				jersey: string;
				did: string;
				imgURL: string;
				imgURLSmall: string;
		  }
		| undefined
	>();

	useEffect(() => {
		const div = divs.find(div => div.did === addEditTeamInfo.did);
		if (!div) {
			throw new Error("Invalid did");
		}

		if (addEditTeamInfo.type === "none") {
			setControlledTeam(undefined);
			return;
		}

		let t: NewLeagueTeamWithoutRank | undefined;
		if (addEditTeamInfo.type === "addRandom") {
			t = {
				tid: -1,
				region: "",
				name: "",
				abbrev: "NEW",
				pop: 1,
				cid: div.cid,
				did: div.did,
			};
		} else if (addEditTeamInfo.type === "edit") {
			t = teams.find(t => t.tid === addEditTeamInfo.tidEdit);
		}

		if (!t) {
			throw new Error("Invalid team");
		}

		setControlledTeam({
			...t,
			region: t.region,
			name: t.name,
			abbrev: t.abbrev,
			pop: String(t.pop),
			stadiumCapacity: String(t.stadiumCapacity ?? DEFAULT_STADIUM_CAPACITY),
			colors: t.colors ?? ["#000000", "#cccccc", "#ffffff"],
			jersey: t.jersey ?? DEFAULT_JERSEY,
			did: String(t.did),
			imgURL: t.imgURL ?? "",
			imgURLSmall: t.imgURLSmall ?? "",
		});
	}, [
		addEditTeamInfo.type,
		addEditTeamInfo.did,
		divs,
		addEditTeamInfo.tidEdit,
		teams,
	]);

	const save = () => {
		if (controlledTeam === undefined) {
			return;
		}
		const did = parseInt(controlledTeam.did);
		const div = divs.find(div => div.did === did);
		if (!div) {
			return;
		}

		const edited = {
			...controlledTeam,
			region: controlledTeam.region,
			name: controlledTeam.name,
			abbrev: controlledTeam.abbrev,
			pop: parseFloat(controlledTeam.pop),
			stadiumCapacity: parseInt(controlledTeam.stadiumCapacity),
			colors: controlledTeam.colors,
			jersey: controlledTeam.jersey,
			did,
			cid: div.cid,
			imgURL: controlledTeam.imgURL,
			imgURLSmall:
				controlledTeam.imgURLSmall === ""
					? undefined
					: controlledTeam.imgURLSmall,
		};

		const errors = [];
		let errorMessage: string | undefined;
		if (Number.isNaN(edited.pop)) {
			errors.push("Population");
		}
		if (Number.isNaN(edited.stadiumCapacity)) {
			errors.push("Stadium Capacity");
		}
		if (errors.length === 1) {
			errorMessage = `${errors[0]} must be a number.`;
		} else if (errors.length > 1) {
			errorMessage = `${errors[0]} and ${errors[1]} must be numbers.`;
		}
		if (errorMessage) {
			logEvent({
				type: "error",
				text: errorMessage,
				saveToDb: false,
			});
			return;
		}

		onSave(edited);
	};

	return (
		<Modal size="lg" show={addEditTeamInfo.type !== "none"} onHide={onCancel}>
			<Modal.Header closeButton>
				{addEditTeamInfo.type === "edit" ? "Edit" : "Add"} Team
			</Modal.Header>
			<Modal.Body>
				{controlledTeam ? (
					<form
						id="foo"
						onSubmit={event => {
							event.preventDefault();
							save();
						}}
					>
						<div className="row">
							<TeamForm
								classNamesCol={[
									"col-6",
									"col-6",
									"col-6",
									"col-6",
									"col-6",
									"col-6",
									"col-6",
									"col-6",
									"col-6",
									"col-6",
								]}
								confs={confs}
								divs={divs}
								handleInputChange={(field, event) => {
									if (field.startsWith("colors")) {
										const ind = parseInt(field.replace("colors", ""));
										if (ind >= 0 && ind <= 2) {
											const colors = [...controlledTeam.colors] as [
												string,
												string,
												string,
											];
											(colors[ind] = event.target.value),
												setControlledTeam({
													...controlledTeam,
													colors,
												});
										}
									} else {
										setControlledTeam({
											...controlledTeam,
											[field]: event.target.value,
										});
									}
								}}
								hideStatus
								t={controlledTeam}
							/>
						</div>
						<button className="d-none" type="submit"></button>
					</form>
				) : null}
				<GodModeWarning
					controlledTeam={controlledTeam}
					godModeLimits={godModeLimits}
				/>
			</Modal.Body>
			<Modal.Footer>
				<button className="btn btn-secondary" onClick={onCancel}>
					Cancel
				</button>
				<button className="btn btn-primary" onClick={save}>
					Save
				</button>
			</Modal.Footer>
		</Modal>
	);
};

export default UpsertTeamModal;
