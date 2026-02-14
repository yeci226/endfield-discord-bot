import { getAttendanceList, executeAttendance } from "./skportApi";
import { Logger } from "./Logger";

const logger = new Logger("AttendanceUtils");

/**
 * Processes attendance for a single game role.
 * Consolidates status checking and execution.
 */
export async function processRoleAttendance(
  role: any,
  gameId: number,
  cookie: string,
  lang: string,
  cred: string,
  salt: string,
  isClaim: boolean,
  tr: any,
  options: any = {},
) {
  const gameRoleStr = `3_${role.roleId}_${role.serverId}`;

  try {
    const res = await getAttendanceList(
      gameRoleStr,
      cookie,
      lang,
      cred,
      salt,
      options,
    );
    let status = res?.data;

    if (!status) {
      return {
        roleId: role.roleId,
        nickname: role.nickname,
        level: role.level,
        error: true,
        message:
          res?.code === 10000
            ? tr("TokenExpired")
            : tr("Error") || "Status request failed",
      };
    }

    let signedNow = false;
    let claimResult = null;

    if (isClaim && !status.hasToday) {
      claimResult = await executeAttendance(
        gameRoleStr,
        cookie,
        lang,
        cred,
        salt,
        options,
      );

      if (
        claimResult &&
        (claimResult.code === 0 || claimResult.code === 10001)
      ) {
        signedNow = true;

        if (claimResult.code === 0 && claimResult.data?.awardIds) {
          // If we got reward info in the response, we can use it directly
          status.awardIds = claimResult.data.awardIds;
          status.hasToday = true;
          // Optionally update resourceInfoMap if it's also provided in the claim response
          if (claimResult.data.resourceInfoMap) {
            status.resourceInfoMap = {
              ...status.resourceInfoMap,
              ...claimResult.data.resourceInfoMap,
            };
          }
        } else {
          // Fallback: Refresh status if reward info wasn't in the claim response or it was code 10001
          const newStatus = await getAttendanceList(
            gameRoleStr,
            cookie,
            lang,
            cred,
            salt,
            options,
          );
          if (newStatus?.data) status = newStatus.data;
        }
      }
    }

    // Extract reward info
    const totalDays = status.calendar.filter((d) => d.done).length;

    let rewardName = tr("None") || "None";
    let rewardIcon = "";

    // Try to get reward from awardIds (from claim response) first
    if (status.awardIds && status.awardIds.length > 0) {
      const awards = status.awardIds.map((award) => {
        const resource = status.resourceInfoMap?.[award.id];
        if (resource) {
          if (!rewardIcon) rewardIcon = resource.icon;
          return `${resource.name} x${resource.count}`;
        }
        return award.id;
      });
      rewardName = awards.join("\n");
    } else {
      // Fallback to calendar status
      const todayReward =
        status.calendar.find((r) => r.available) ||
        [...status.calendar].reverse().find((r) => r.done);

      if (todayReward) {
        const resInfo = status.resourceInfoMap?.[todayReward.awardId];
        if (resInfo) {
          rewardName = `${resInfo.name} x${resInfo.count}`;
          rewardIcon = resInfo.icon;
        }
      }
    }

    let firstRewardName = "";
    if (status.first && status.first.length > 0) {
      // Find a newcomer reward that is:
      // 1. Available to claim right now AND not done
      // 2. OR just claimed successfully
      const targetFirst = status.first.find((f) => {
        if (f.available && !f.done) return true;
        if (signedNow && status.awardIds?.some((a) => a.id === f.awardId))
          return true;
        return false;
      });

      if (targetFirst) {
        const fRes = status.resourceInfoMap[targetFirst.awardId];
        if (fRes) {
          firstRewardName = `${fRes.name} x${fRes.count}`;

          // If this reward is already in rewardName (because it was in awardIds),
          // we should remove it from rewardName to avoid showing it twice,
          // or just keep it as the "Newbie Reward" specifically.
          // For now, we'll just ensure it's not showing as the "Main" reward if possible.
          // However, if awardIds has multiple, rewardName already has them all joined.
          // We'll leave the dual-display for now as it's safer, but the !f.done check
          // should fix the "showing old rewards" issue.
        }
      }
    }

    return {
      roleId: role.roleId,
      nickname: role.nickname,
      level: role.level,
      hasToday: status.hasToday || signedNow,
      signedNow: signedNow,
      totalDays: totalDays,
      rewardName: rewardName,
      rewardIcon: rewardIcon,
      firstRewardName: firstRewardName,
      error: !status.hasToday && !signedNow && isClaim,
      message: claimResult?.message,
    };
  } catch (error: any) {
    logger.error(`Error for role ${role.roleId}: ${error.message}`);
    return {
      roleId: role.roleId,
      nickname: role.nickname,
      level: role.level,
      error: true,
      message: error.message,
    };
  }
}
