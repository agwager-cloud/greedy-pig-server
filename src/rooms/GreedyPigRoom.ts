import { Room, Client } from "@colyseus/core";
import { GreedyPigPlayer } from "../schema/GreedyPigPlayer.js";
import { GreedyPigState } from "../schema/GreedyPigState.js";

import { generateRoomCode } from "../utils/roomCode.js";
import {
  areAllPlayersDoneForRound,
  getExpectedSubmittedTotal,
  isKnockoutRoll,
} from "../utils/rules.js";

type UpdateSettingsPayload = {
  mode?: "rounds" | "points";
  roundsToPlay?: number;
  pointsGoal?: number;
  diceCount?: number;
  diceSides?: 6 | 8 | 10 | 12 | 20;
  knockoutNumbers?: number[];
  safeRollsEnabled?: boolean;
  multiplierEnabled?: boolean;
};

type JoinOptions = {
  name?: string;
  isHost?: boolean;
  roomCode?: string;
};

type HostRollResultPayload = {
  die1: number;
  die2?: number;
  diceCount: number;
  diceSides: 6 | 8 | 10 | 12 | 20;
};

export class GreedyPigRoom extends Room {
  declare state: GreedyPigState;
  maxClients = 40;

  onCreate() {
    this.setState(new GreedyPigState());
    this.state.roomCode = generateRoomCode(4);
    this.state.settings.knockoutNumbers.push(2);

    this.onMessage(
      "update_settings",
      (client, payload: UpdateSettingsPayload) => {
        if (client.sessionId !== this.state.hostSessionId) return;
        if (this.state.phase !== "lobby") return;

        if (payload.mode) this.state.settings.mode = payload.mode;
        if (typeof payload.roundsToPlay === "number") {
          this.state.settings.roundsToPlay = Math.max(1, payload.roundsToPlay);
        }
        if (typeof payload.pointsGoal === "number") {
          this.state.settings.pointsGoal = Math.max(1, payload.pointsGoal);
        }
        if (typeof payload.diceCount === "number") {
          this.state.settings.diceCount = Math.max(
            1,
            Math.min(2, payload.diceCount),
          );
        }
        if (typeof payload.diceSides === "number") {
          this.state.settings.diceSides = payload.diceSides;
        }

        if (typeof payload.safeRollsEnabled === "boolean") {
          this.state.settings.safeRollsEnabled = payload.safeRollsEnabled;
        }

        if (typeof payload.multiplierEnabled === "boolean") {
          this.state.settings.multiplierEnabled = payload.multiplierEnabled;
        }

        if (
          Array.isArray(payload.knockoutNumbers) &&
          payload.knockoutNumbers.length > 0
        ) {
          this.state.settings.knockoutNumbers.clear();
          payload.knockoutNumbers.forEach((n) => {
            this.state.settings.knockoutNumbers.push(n);
          });
        }
        const defaultKo = this.getDefaultKnockoutNumbers(
          this.state.settings.diceCount,
          this.state.settings.diceSides,
        );

        const currentKo = [...this.state.settings.knockoutNumbers];
        const maxKoValue =
          this.state.settings.diceCount === 2
            ? this.state.settings.diceSides * 2
            : this.state.settings.diceSides;

        const hasInvalidKo =
          currentKo.length === 0 ||
          currentKo.some((n) => n < 1 || n > maxKoValue);

        if (hasInvalidKo) {
          this.state.settings.knockoutNumbers.clear();
          defaultKo.forEach((n) => this.state.settings.knockoutNumbers.push(n));
        }
      },
    );
    this.onMessage("start_game", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      if (this.state.phase !== "lobby") return;
      this.startGame();
    });

    this.onMessage("roll_die", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      if (this.state.phase !== "awaiting_roll") return;

      this.state.phase = "rolling_animation";

      this.broadcast("host_roll_requested", {
        diceCount: Number(this.state.settings.diceCount ?? 1),
        diceSides: Number(this.state.settings.diceSides ?? 6),
      });
    });

    this.onMessage(
      "host_roll_result",
      (client, payload: HostRollResultPayload) => {
        if (client.sessionId !== this.state.hostSessionId) return;
        if (this.state.phase !== "rolling_animation") return;
        if (!payload) return;

        const diceCount = Number(payload.diceCount ?? 1);
        const diceSides = Number(
          payload.diceSides ?? this.state.settings.diceSides ?? 6,
        );

        const die1 = Number(payload.die1 ?? 0);
        const die2 = diceCount === 2 ? Number(payload.die2 ?? 0) : null;

        if (!Number.isInteger(die1) || die1 < 1 || die1 > diceSides) return;

        if (diceCount === 2) {
          if (
            !Number.isInteger(die2) ||
            (die2 ?? 0) < 1 ||
            (die2 ?? 0) > diceSides
          ) {
            return;
          }
        }

        this.applyHostResolvedRoll(die1, die2, diceCount, diceSides);
      },
    );

    this.onMessage("submit_total", (client, submittedTotal: number) => {
      if (this.state.phase !== "awaiting_answers") return;

      const player = this.state.players.get(client.sessionId);
      if (!player || player.hasSaved || player.isBusted) return;
      if (player.hasAnsweredThisRoll) return;

      const expected = getExpectedSubmittedTotal(
        player,
        this.state.currentRoll,
        this.state.settings.multiplierEnabled,
        this.state.currentRound,
      );

      if (submittedTotal === expected) {
        player.roundSubtotal = submittedTotal;
        player.hasAnsweredThisRoll = true;
        client.send("correct_total", { submittedTotal });

        this.checkForRoundEnd();
      } else {
        const multiplierEnabled = this.state.settings.multiplierEnabled;
        const currentRound = this.state.currentRound;

        let expectedHint = "Try again";

        if (multiplierEnabled && currentRound > 1) {
          const unmultipliedGuess =
            player.roundSubtotal + this.state.currentRoll;

          if (submittedTotal === unmultipliedGuess) {
            expectedHint = "Incorrect. Please add the round multiplier.";
          } else {
            expectedHint = `Incorrect. Round ${currentRound} uses ×${currentRound}. Try again.`;
          }
        } else {
          expectedHint = "Incorrect total. Try again.";
        }

        client.send("incorrect_total", { expectedHint });
      }
    });
    this.onMessage("save_round", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (
        this.state.phase !== "awaiting_answers" &&
        this.state.phase !== "awaiting_roll"
      )
        return;
      if (player.hasSaved || player.isBusted) return;
      if (!player.hasAnsweredThisRoll) return;

      player.hasSaved = true;
      player.bankedScore += player.roundSubtotal;

      client.send("round_saved", {
        roundSubtotal: player.roundSubtotal,
        bankedScore: player.bankedScore,
      });

      this.checkForRoundEnd();
    });

    this.onMessage("next_round", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      if (this.state.phase !== "round_summary") return;

      if (this.isGameOver()) {
        this.state.phase = "game_over";
        this.broadcast("game_over", {});
        return;
      }

      this.state.currentRound += 1;
      this.state.currentRoll = 0;
      this.state.rollCountThisRound = 0;
      this.resetRoundFlags();
      this.state.phase = "awaiting_roll";

      this.broadcast("round_started", { round: this.state.currentRound });
    });

    this.onMessage("play_again", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      this.resetForNewGame(false);
    });

    this.onMessage("return_to_lobby", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      this.returnToLobby();
    });
  }
  onJoin(client: Client, options: JoinOptions) {
    const requestedRoomCode = (options.roomCode || "")
      .trim()
      .toUpperCase()
      .slice(0, 4); // 👈 limit to 4 chars

    if (!options.isHost) {
      if (requestedRoomCode !== this.state.roomCode) {
        client.leave(4001, "Invalid room code");
        return;
      }

      if (this.state.phase !== "lobby") {
        client.leave(4002, "Game already started");
        return;
      }
    }

    const player = new GreedyPigPlayer();
    player.sessionId = client.sessionId;

    player.name =
      (options.name || "Player").trim().replace(/\s+/g, " ").slice(0, 10) ||
      "Player";

    player.isHost = !!options.isHost;
    player.isConnected = true;

    if (player.isHost && !this.state.hostSessionId) {
      this.state.hostSessionId = client.sessionId;
    }

    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (client.sessionId === this.state.hostSessionId) {
      this.disconnect();
      return;
    }

    this.state.players.delete(client.sessionId);

    let activeStudentCount = 0;
    for (const p of this.state.players.values()) {
      if (!p.isHost) activeStudentCount++;
    }

    if (activeStudentCount === 0) {
      this.returnToLobby();
      return;
    }

    if (
      this.state.phase === "awaiting_answers" ||
      this.state.phase === "awaiting_roll"
    ) {
      this.checkForRoundEnd();
    }
  }

  private returnToLobby() {
    this.resetForNewGame(true);
  }

  private getDefaultKnockoutNumbers(
    diceCount: number,
    diceSides: number,
  ): number[] {
    if (diceCount === 2) {
      if (diceSides === 6) return [7];
      if (diceSides === 8) return [9];
      if (diceSides === 10) return [11];
      if (diceSides === 12) return [13];
      if (diceSides === 20) return [21];
      return [7];
    }

    if (diceSides === 6) return [2];
    if (diceSides === 8) return [2];
    if (diceSides === 10) return [2];
    if (diceSides === 12) return [2];
    if (diceSides === 20) return [2, 5, 10, 15];

    return [2];
  }

  private buildRollMessage(
    die1: number,
    die2: number | null,
    diceCount: number,
    diceSides: number,
    safe: boolean,
  ) {
    return {
      roll: diceCount === 2 ? die1 + (die2 ?? 0) : die1,
      die1,
      die2: die2 ?? undefined,
      diceCount,
      diceSides,
      safe,
    };
  }

  private startGame() {
    this.state.currentRound = 1;
    this.state.currentRoll = 0;
    this.state.rollCountThisRound = 0;
    this.resetRoundFlags();
    this.state.phase = "awaiting_roll";
    this.broadcast("round_started", { round: this.state.currentRound });
  }

  private applyHostResolvedRoll(
    die1: number,
    die2: number | null,
    diceCount: number,
    diceSides: number,
  ) {
    const total = diceCount === 2 ? die1 + (die2 ?? 0) : die1;

    this.state.currentRoll = total;
    this.state.rollCountThisRound += 1;

    for (const player of this.state.players.values()) {
      if (player.isHost || player.isConnected === false) continue;
      if (!player.hasSaved && !player.isBusted) {
        player.rollsThisRound += 1;
      }
    }

    const knockoutHit = isKnockoutRoll(this.state);
    let bustedAnyone = false;
    let safeAnyone = false;

    if (knockoutHit) {
      for (const player of this.state.players.values()) {
        if (player.isHost || player.isConnected === false) continue;
        if (player.hasSaved || player.isBusted) continue;

        const isSafeRoll =
          this.state.settings.safeRollsEnabled && player.rollsThisRound <= 2;

        if (isSafeRoll) {
          player.hasAnsweredThisRoll = false;
          safeAnyone = true;
          continue;
        }

        player.roundSubtotal = 0;
        player.isBusted = true;
        player.hasAnsweredThisRoll = true;
        bustedAnyone = true;
      }

      this.state.phase = "awaiting_answers";

      const payload = this.buildRollMessage(
        die1,
        die2,
        diceCount,
        diceSides,
        false,
      );

      if (bustedAnyone) {
        this.broadcast("round_knockout", payload);
      } else {
        this.broadcast(
          "roll_result",
          this.buildRollMessage(die1, die2, diceCount, diceSides, safeAnyone),
        );
      }

      this.checkForRoundEnd();
      return;
    }

    for (const player of this.state.players.values()) {
      if (player.isHost || player.isConnected === false) continue;

      if (!player.hasSaved && !player.isBusted) {
        player.hasAnsweredThisRoll = false;
      }
    }

    this.state.phase = "awaiting_answers";
    this.broadcast(
      "roll_result",
      this.buildRollMessage(die1, die2, diceCount, diceSides, false),
    );
  }

  private checkForRoundEnd() {
    if (!areAllPlayersDoneForRound(this.state)) {
      let everyoneAnswered = true;

      for (const player of this.state.players.values()) {
        if (player.isHost || player.isConnected === false) continue;

        if (
          !player.hasSaved &&
          !player.isBusted &&
          !player.hasAnsweredThisRoll
        ) {
          everyoneAnswered = false;
          break;
        }
      }

      if (everyoneAnswered) {
        this.state.phase = "awaiting_roll";
      }

      return;
    }

    this.state.phase = "round_summary";

    const isFinalRound = this.isGameOver();

    this.broadcast("round_ended", {
      round: this.state.currentRound,
      isFinalRound,
    });
  }

  private resetRoundFlags() {
    for (const player of this.state.players.values()) {
      player.roundSubtotal = 0;
      player.rollsThisRound = 0;
      player.hasSaved = false;
      player.isBusted = false;
      player.hasAnsweredThisRoll = false;
    }
  }
  private isGameOver(): boolean {
    if (this.state.settings.mode === "rounds") {
      return this.state.currentRound >= this.state.settings.roundsToPlay;
    }

    if (this.state.settings.mode === "points") {
      for (const player of this.state.players.values()) {
        if (player.bankedScore >= this.state.settings.pointsGoal) {
          return true;
        }
      }
    }

    return false;
  }

  private resetForNewGame(returnToLobby: boolean) {
    for (const player of this.state.players.values()) {
      player.bankedScore = 0;
      player.roundSubtotal = 0;
      player.hasSaved = false;
      player.isBusted = false;
      player.hasAnsweredThisRoll = false;
      player.rollsThisRound = 0;
    }

    this.state.currentRound = 1;
    this.state.currentRoll = 0;
    this.state.rollCountThisRound = 0;
    this.state.phase = returnToLobby ? "lobby" : "awaiting_roll";

    // Re-validate KO against current settings
    const diceCount = Number(this.state.settings.diceCount ?? 1);
    const diceSides = Number(this.state.settings.diceSides ?? 6);

    const currentKo =
      this.state.settings.knockoutNumbers &&
      typeof this.state.settings.knockoutNumbers[Symbol.iterator] === "function"
        ? Array.from(
            this.state.settings.knockoutNumbers as Iterable<number>,
          ).map((n) => Number(n))
        : [];

    const maxKoValue = diceCount === 2 ? diceSides * 2 : diceSides;
    const hasInvalidKo =
      currentKo.length === 0 ||
      currentKo.some((n) => !Number.isFinite(n) || n < 1 || n > maxKoValue);

    if (hasInvalidKo) {
      this.state.settings.knockoutNumbers.clear();
      const defaults = this.getDefaultKnockoutNumbers(diceCount, diceSides);
      defaults.forEach((n) => this.state.settings.knockoutNumbers.push(n));
    }

    if (returnToLobby) {
      this.broadcast("returned_to_lobby", {});
    } else {
      this.broadcast("round_started", { round: this.state.currentRound });
    }
  }
}
