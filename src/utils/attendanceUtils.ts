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

    let rewards: string[] = [];
    let rewardIcon = "";

    // 1. Try to get rewards from awardIds (the prioritized source from Python code)
    if (status.awardIds && status.awardIds.length > 0) {
      for (const award of status.awardIds) {
        const resource = status.resourceInfoMap?.[award.id];
        if (resource) {
          if (!rewardIcon) rewardIcon = resource.icon;
          rewards.push(`${resource.name} x${resource.count}`);
        }
      }
    }

    // 2. Fallback to calendar if rewards empty
    if (rewards.length === 0) {
      const todayReward =
        status.calendar.find((r) => r.available) ||
        [...status.calendar].reverse().find((r) => r.done);

      if (todayReward) {
        const resInfo = status.resourceInfoMap?.[todayReward.awardId];
        if (resInfo) {
          rewards.push(`${resInfo.name} x${resInfo.count}`);
          rewardIcon = resInfo.icon;
        }
      }
    }

    const rewardName =
      rewards.length > 0 ? rewards.join("\n") : tr("None") || "None";

    let firstRewardName = "";
    if (status.first && status.first.length > 0) {
      // Find a newcomer reward that is either currently available or was just claimed
      const targetFirst = status.first.find((f) => {
        if (f.available && !f.done) return true;
        if (signedNow && status.awardIds?.some((a) => a.id === f.awardId))
          return true;
        return false;
      });

      if (targetFirst) {
        const fRes = status.resourceInfoMap?.[targetFirst.awardId];
        if (fRes) {
          firstRewardName = `${fRes.name} x${fRes.count}`;
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
