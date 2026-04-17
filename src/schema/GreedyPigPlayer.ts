import { Schema, type } from "@colyseus/schema";

export class GreedyPigPlayer extends Schema {
  @type("string") sessionId: string = "";
  @type("string") name: string = "";
  @type("boolean") isHost: boolean = false;
  @type("boolean") isConnected: boolean = true;
  @type("boolean") activeThisRound: boolean = true;
  @type("boolean") justRejoined: boolean = false;
  @type("boolean") waitingForNextRound: boolean = false;

  @type("number") rollsThisRound: number = 0;

  @type("number") bankedScore: number = 0;
  @type("number") roundSubtotal: number = 0;

  @type("boolean") hasSaved: boolean = false;
  @type("boolean") isBusted: boolean = false;
  @type("boolean") hasAnsweredThisRoll: boolean = false;
  @type("boolean") wantsToContinue = false;
}
