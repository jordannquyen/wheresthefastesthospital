import { readFileSync } from "node:fs";

const nodesPath = new URL("./nodes.json", import.meta.url);
const nodeList = JSON.parse(readFileSync(nodesPath, "utf8"));

const telemetryState = Object.fromEntries(
  nodeList.map((node) => [
    node.id,
    {
      utilization: Number(randomFloat(0.1, 0.42).toFixed(2)),
      waitMins: seedRange(6, 26),
      availableBeds: seedRange(24, 70),
      updatedAt: new Date().toISOString(),
    },
  ]),
);

let lastUpdatedAt = new Date().toISOString();

function jitterTelemetry() {
  for (const node of nodeList) {
    const current = telemetryState[node.id];

    const utilization = Number(clamp(
      current.utilization + randomFloat(-0.09, 0.11),
      0.05,
      0.98,
    ).toFixed(2));

    const waitMins = Math.round(clamp(current.waitMins + randomFloat(-6, 7), 4, 95));
    const availableBeds = Math.round(clamp(80 - utilization * 76 + randomFloat(-4, 5), 2, 82));

    telemetryState[node.id] = {
      utilization,
      waitMins,
      availableBeds,
      updatedAt: new Date().toISOString(),
    };
  }

  lastUpdatedAt = new Date().toISOString();
}

function getTelemetry() {
  return {
    updatedAt: lastUpdatedAt,
    nodes: telemetryState,
  };
}

function getNodes() {
  return nodeList;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function seedRange(min, max) {
  return Math.round(Math.random() * (max - min) + min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export { getNodes, getTelemetry, jitterTelemetry };
