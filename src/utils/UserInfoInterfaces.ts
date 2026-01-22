export interface UserBasicInfo {
  id: string;
  nickname: string;
  avatar: string;
  profile: string;
  avatarCode: number;
  gender: number;
  status: number;
  operationStatus: number;
  identity: number;
  kind: number;
  moderatorStatus: number;
  moderatorChangeTime: number;
  createdAt: string;
  latestLoginAt: string;
}

export interface UserInfoResponse {
  code: number;
  message: string;
  timestamp: string;
  data: {
    user: {
      basicUser: UserBasicInfo;
      pendant?: any;
      background?: any;
    };
    userRts?: {
      follow: string;
      fans: string;
      liked: string;
    };
    userSanctionList?: any[];
    userInfoApply?: any;
    moderator?: any;
  };
}
