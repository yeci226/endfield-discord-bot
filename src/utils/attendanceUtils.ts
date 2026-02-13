import { getAttendanceList, executeAttendance } from "./skportApi";

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
) {
  const gameRoleStr = `3_${role.roleId}_${role.serverId}`;

  try {
    let status = await getAttendanceList(gameRoleStr, cookie, lang, cred, salt);

    if (!status) {
      return {
        roleId: role.roleId,
        nickname: role.nickname,
        level: role.level,
        error: true,
        message: tr("Error") || "Status request failed",
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
          );
          if (newStatus) status = newStatus;
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
    if (status.first) {
      // Find a newcomer reward that is either available to claim OR was just claimed (available in new status or matches awardId)
      const targetFirst = status.first.find((f) => {
        if (f.available) return true;
        // If we just signed in and this reward matches one of the awardIds, it's the one we just got
        if (signedNow && status.awardIds?.some((a) => a.id === f.awardId))
          return true;
        return false;
      });

      if (targetFirst) {
        const fRes = status.resourceInfoMap[targetFirst.awardId];
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
    console.error(`[AttendanceUtils] Error for role ${role.roleId}:`, error);
    return {
      roleId: role.roleId,
      nickname: role.nickname,
      level: role.level,
      error: true,
      message: error.message,
    };
  }
}
