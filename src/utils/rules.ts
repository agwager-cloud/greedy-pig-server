import { GreedyPigPlayer } from "../schema/GreedyPigPlayer.js";
import { GreedyPigState } from "../schema/GreedyPigState.js";

export function isKnockoutRoll(state: GreedyPigState): boolean {
  return Array.from(state.settings.knockoutNumbers).includes(state.currentRoll);
}

export function getExpectedSubmittedTotal(
  player: GreedyPigPlayer,
  currentRoll: number,
  multiplierEnabled: boolean,
  currentRound: number,
): number {
  const multiplier = multiplierEnabled ? currentRound : 1;
  return player.roundSubtotal + currentRoll * multiplier;
}

export function areAllPlayersDoneForRound(state: GreedyPigState): boolean {
  for (const player of state.players.values()) {
    if (player.isHost) continue;

    if (!player.hasSaved && !player.isBusted) {
      return false;
    }
  }
  return true;
}

export function countConnectedPlayers(state: GreedyPigState): number {
  let count = 0;
  for (const player of state.players.values()) {
    if (player.isConnected) count++;
  }
  return count;
}
