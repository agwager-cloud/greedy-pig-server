import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import { GreedyPigPlayer } from "./GreedyPigPlayer";

export class GreedyPigSettings extends Schema {
  @type("string") mode: string = "rounds"; // "rounds" | "points"
  @type("number") roundsToPlay: number = 4;
  @type("number") pointsGoal: number = 100;
  @type("number") diceCount: number = 1;
  @type("number") diceSides: number = 6; // 6 | 8 | 10 | 20
  @type(["number"]) knockoutNumbers = new ArraySchema<number>();
  @type("boolean") safeRollsEnabled: boolean = true;
  @type("boolean") multiplierEnabled: boolean = false;
}

export class GreedyPigState extends Schema {
  @type("string") roomCode: string = "";
  @type("string") hostSessionId: string = "";
  @type("string") phase: string = "lobby";

  @type(GreedyPigSettings) settings = new GreedyPigSettings();

  @type("number") currentRound: number = 1;
  @type("number") currentRoll: number = 0;
  @type("number") rollCountThisRound: number = 0;

  @type({ map: GreedyPigPlayer })
  players = new MapSchema<GreedyPigPlayer>();
}
