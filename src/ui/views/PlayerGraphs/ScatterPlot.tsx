import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Circle, LinePath } from "@visx/shape";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { localPoint } from "@visx/event";
import { useTooltip, TooltipWithBounds } from "@visx/tooltip";
import { useRef, type MouseEvent } from "react";
import { helpers } from "../../util";

export type TooltipData = {
	x: number;
	y: number;
	pid: number;
	name: string;
};

type ScatterPlotProps = {
	data: TooltipData[];
	descShort: [string, string];
	descLong: [string | undefined, string | undefined];
	stat: [string, string];
	statType: [string, string];
};

const linearRegression = (
	points: {
		x: number;
		y: number;
	}[],
) => {
	const numPoints = points.length;

	let rSquared = 1;

	if (numPoints === 0) {
		return {
			m: 0,
			b: 0,
			rSquared,
		};
	}

	let sum_x = 0;
	let sum_y = 0;
	let sum_xy = 0;
	let sum_xx = 0;

	for (const point of points) {
		const { x, y } = point;
		sum_x += x;
		sum_y += y;
		sum_xx += x * x;
		sum_xy += x * y;
	}

	const m =
		(numPoints * sum_xy - sum_x * sum_y) / (numPoints * sum_xx - sum_x * sum_x);
	const b = sum_y / numPoints - (m * sum_x) / numPoints;

	if (numPoints > 1) {
		const yAvg = sum_y / numPoints;

		let sumSquaresTotal = 0;
		for (const point of points) {
			sumSquaresTotal += Math.pow(point.y - yAvg, 2);
		}

		let sumSquaresResidual = 0;
		for (const point of points) {
			sumSquaresResidual += Math.pow(point.y - (m * point.x + b), 2);
		}

		if (sumSquaresResidual !== 0) {
			rSquared = 1 - sumSquaresResidual / sumSquaresTotal;
		}
	}

	return { m, b, rSquared };
};

const getFormattedStat = (value: number, stat: string, statType: string) => {
	if (statType === "bio") {
		if (stat === "salary") {
			return helpers.formatCurrency(value, "M");
		}
		if (stat === "draftPosition") {
			return helpers.ordinal(value);
		}
	}
	if (statType === "bio" || statType === "ratings") {
		return value;
	}
	return helpers.roundStat(value, stat, statType === "totals");
};

const ScatterPlot = (
	props: ScatterPlotProps & {
		width: number;
	},
) => {
	const HEIGHT = 400;

	const x = (d: any): number => {
		return d.x;
	};

	const y = (d: any): number => d.y;
	const xDomain = [
		Math.min(...props.data.map(x)),
		Math.max(...props.data.map(x)) * 1.05,
	];

	const yDomain = [
		Math.min(...props.data.map(y)),
		Math.max(...props.data.map(y)) * 1.05,
	];

	// tooltip handler
	const {
		showTooltip,
		hideTooltip,
		tooltipData,
		tooltipOpen,
		tooltipTop,
		tooltipLeft,
	} = useTooltip<TooltipData>();

	const svgRef = useRef(null);

	const margin = { top: 10, left: 60, right: 10, bottom: 60 };
	const width = props.width - margin.left - margin.right;
	const xScale = scaleLinear({
		domain: xDomain,
		range: [0, width],
	});
	const yScale = scaleLinear({
		domain: yDomain,
		range: [HEIGHT, 0],
	});

	const { m, b, rSquared } = linearRegression(props.data);

	const avg = (x: number) => {
		return m * x + b;
	};

	const handleMouseOver = (event: MouseEvent, data: TooltipData) => {
		const coords = localPoint((event.target as any).ownerSVGElement, event);
		if (coords) {
			showTooltip({
				tooltipLeft: coords.x,
				tooltipTop: coords.y,
				tooltipData: data,
			});
		}
	};

	const fontSizeProps = {
		fontSize: "1em",
	};

	const labels = ([0, 1] as const).map(
		i =>
			`${props.descShort[i]}${
				props.descLong[i] !== undefined ? ` (${props.descLong[i]})` : ""
			}`,
	);

	const rSquaredRounded = Math.round(100 * rSquared) / 100;

	return (
		<div>
			<svg
				width={props.width}
				height={HEIGHT + margin.top + margin.bottom}
				ref={svgRef}
			>
				<Group transform={`translate(${margin.left},${margin.top})`}>
					<AxisLeft
						axisClassName="chart-axis"
						scale={yScale}
						label={labels[1]}
						labelProps={{
							...fontSizeProps,

							// Weird that this is required to center label
							textAnchor: "middle",
						}}
						tickLabelProps={fontSizeProps}
					/>
					<AxisBottom
						axisClassName="chart-axis"
						scale={xScale}
						top={HEIGHT}
						label={labels[0]}
						labelProps={{
							...fontSizeProps,
							dy: "1.5em",

							// Weird that this is required to center label
							textAnchor: "middle",
						}}
						tickLabelProps={fontSizeProps}
					/>
					<LinePath
						y={d => yScale(avg(d))}
						x={d => xScale(d)}
						stroke={"var(--bs-red)"}
						data={xDomain}
						opacity={0.7}
						strokeWidth={4}
					/>
					{props.data.map((d, i) => {
						return (
							<a key={i} href={helpers.leagueUrl(["player", d.pid])}>
								<Circle
									key={i}
									cx={xScale(x(d))}
									cy={yScale(y(d))}
									fillOpacity={0.8}
									onMouseOver={event => handleMouseOver(event, d)}
									onMouseOut={hideTooltip}
									r={5}
									fill={"var(--bs-blue)"}
								/>
							</a>
						);
					})}
					<text
						x="10"
						y="10"
						style={{
							fill: "var(--bs-black)",
						}}
					>
						R
						<tspan
							baselineShift="super"
							style={{
								fontSize: 10,
							}}
						>
							2
						</tspan>{" "}
						= {rSquaredRounded}
					</text>
				</Group>
			</svg>
			{tooltipOpen && tooltipData ? (
				<TooltipWithBounds left={tooltipLeft} top={tooltipTop}>
					<h3>{tooltipData.name}</h3>
					{([0, 1] as const).map(i => {
						return (
							<div key={i}>
								{getFormattedStat(
									tooltipData[i === 0 ? "x" : "y"],
									props.stat[i],
									props.statType[i],
								)}{" "}
								{props.descShort[i]}
							</div>
						);
					})}
				</TooltipWithBounds>
			) : null}
		</div>
	);
};

export const StatGraph = (props: ScatterPlotProps) => {
	return (
		<div className="position-relative">
			<ParentSize>
				{parent => <ScatterPlot width={parent.width} {...props} />}
			</ParentSize>
		</div>
	);
};
