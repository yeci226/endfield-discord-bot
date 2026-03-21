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
        signedNow = claimResult.code === 0;

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
    const calendarTotalDays = Array.isArray(status.calendar)
      ? status.calendar.length
      : 0;

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

    const availableIndex = status.calendar.findIndex((r) => r.available);
    const firstUndoneIndex = status.calendar.findIndex((r) => !r.done);
    const lastDoneIndex = [...status.calendar]
      .reverse()
      .findIndex((r) => r.done);
    const resolvedLastDoneIndex =
      lastDoneIndex >= 0 ? status.calendar.length - 1 - lastDoneIndex : -1;

    // If today's attendance is already done, the current reward should be the latest done day,
    // not the first pending day.
    const currentIndex =
      status.hasToday || signedNow
        ? resolvedLastDoneIndex
        : availableIndex >= 0
          ? availableIndex
          : firstUndoneIndex >= 0
            ? firstUndoneIndex
            : resolvedLastDoneIndex;

    const currentRewardEntry =
      currentIndex >= 0 ? status.calendar[currentIndex] : null;

    const todayAnchorIndex =
      availableIndex >= 0
        ? availableIndex
        : status.hasToday || signedNow
          ? currentIndex
          : firstUndoneIndex >= 0
            ? firstUndoneIndex
            : resolvedLastDoneIndex;

    const checkedDaysThisMonth = todayAnchorIndex >= 0 ? todayAnchorIndex + 1 : 0;
    const missedDaysThisMonth =
      todayAnchorIndex > 0
        ? status.calendar.slice(0, todayAnchorIndex).filter((d) => !d.done).length
        : 0;

    const yesterdayRewardEntry =
      currentIndex > 0
        ? status.calendar[currentIndex - 1]
        : [...status.calendar].reverse().find((r) => r.done);

    const currentResource = currentRewardEntry
      ? status.resourceInfoMap?.[currentRewardEntry.awardId]
      : null;

    const todayReward = {
      name: currentResource
        ? `${currentResource.name} x${currentResource.count}`
        : rewardName,
      icon: currentResource?.icon || rewardIcon,
      done: !!(status.hasToday || signedNow),
    };

    const yesterdayResource = yesterdayRewardEntry
      ? status.resourceInfoMap?.[yesterdayRewardEntry.awardId]
      : null;

    const yesterdayReward = {
      name: yesterdayResource
        ? `${yesterdayResource.name} x${yesterdayResource.count}`
        : tr("None") || "None",
      icon: yesterdayResource?.icon || "",
      done: !!yesterdayRewardEntry?.done,
    };

    const nextRewards = status.calendar
      .slice(currentIndex + 1, currentIndex + 4)
      .map((dayReward) => {
        const reward = status.resourceInfoMap?.[dayReward.awardId];
        if (!reward) {
          return {
            name: tr("None") || "None",
            icon: "",
          };
        }

        return {
          name: `${reward.name} x${reward.count}`,
          icon: reward.icon,
        };
      });

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
      calendarTotalDays,
      rewardName: rewardName,
      rewardIcon: rewardIcon,
      yesterdayReward,
      todayReward,
      nextRewards,
      checkedDaysThisMonth,
      missedDaysThisMonth,
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
