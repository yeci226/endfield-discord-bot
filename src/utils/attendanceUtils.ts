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

      if (claimResult && claimResult.code === 0) {
        signedNow = true;
        // Refresh status to get updated reward info
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

    // Extract reward info
    const totalDays = status.calendar.filter((d) => d.done).length;
    const todayReward =
      status.calendar.find((r) => r.available) ||
      [...status.calendar].reverse().find((r) => r.done);

    let rewardName = tr("None") || "None";
    let rewardIcon = "";

    if (todayReward) {
      const resInfo = status.resourceInfoMap?.[todayReward.awardId];
      if (resInfo) {
        rewardName = `${resInfo.name} x${resInfo.count}`;
        rewardIcon = resInfo.icon;
      }
    }

    let firstRewardName = "";
    if (status.first) {
      const targetFirst = status.first.find((f) => f.available || f.done);
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
