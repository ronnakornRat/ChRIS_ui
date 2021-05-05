import {
  all,
  fork,
  takeEvery,
  put,
  call,
  delay,
} from "@redux-saga/core/effects";
import { Task } from "redux-saga";
import { IActionTypeParam } from "../../api/models/base.model";
import { ResourceTypes, PluginStatusLabels } from "./types";
import { PluginInstance, PluginInstanceFileList } from "@fnndsc/chrisapi";
import { inflate } from "pako";
import {
  getPluginInstanceResourceSuccess,
  stopFetchingPluginResources,
  stopFetchingStatusResources,
  getPluginFilesSuccess,
  getPluginFilesError,
  getPluginInstanceStatusSuccess,
} from "./actions";

function* fetchPluginFiles(plugin: PluginInstance) {
  try {
    const params = { limit: 200, offset: 0 };
    let fileList: PluginInstanceFileList = yield plugin.getFiles(params);
    let files = fileList.getItems();

    while (fileList.hasNextPage) {
      try {
        params.offset += params.limit;
        fileList = yield plugin.getFiles(params);
        files = files.concat(fileList.getItems());
      } catch (e) {
        throw new Error("Error while paginating files");
      }
    }

    const id = plugin.data.id;
    const payload = {
      id,
      files,
    };

    if (files.length > 0) yield put(getPluginFilesSuccess(payload));
  } catch (error) {
    const id = plugin.data.id;
    const payload = {
      id,
      error,
    };
    yield put(getPluginFilesError(payload));
  }
}

function* handleGetPluginStatus(instance: PluginInstance) {
  while (true) {
    try {
      const pluginDetails = yield instance.get();
      const pluginStatus = yield pluginDetails.data.summary;

      let parsedStatus: PluginStatusLabels | undefined = undefined;
      if (pluginStatus) {
        parsedStatus = JSON.parse(pluginStatus);
      }

      let output = {};
      if (pluginDetails.data.raw.length > 0) {
        output = getLog(pluginDetails.data.raw);
      }

      const payload = {
        id: pluginDetails.data.id,
        pluginStatus: parsedStatus,
        pluginLog: output,
        pluginDetails: pluginDetails,
      };
      yield put(getPluginInstanceResourceSuccess(payload));
      if (
        pluginDetails.data.status === "finishedWithError" ||
        pluginDetails.data.status === "cancelled"
      ) {
        yield put(stopFetchingPluginResources(instance.data.id));
      }
      if (pluginDetails.data.status === "finishedSuccessfully") {
        yield call(fetchPluginFiles, instance);
        yield put(stopFetchingPluginResources(instance.data.id));
      } else {
        yield delay(7000);
      }
    } catch (error) {
      yield put(stopFetchingPluginResources(instance.data.id));
    }
  }
}

function* handleGetInstanceStatus(instance: PluginInstance) {
  while (true) {
    try {
      const pluginDetails = yield instance.get();
      yield put(
        getPluginInstanceStatusSuccess({
          selected: instance,
          status: instance.data.status,
        })
      );
      if (
        pluginDetails.data.status === "finishedWithError" ||
        pluginDetails.data.status === "cancelled"
      ) {
        yield put(stopFetchingStatusResources(instance.data.id));
      }
      if (pluginDetails.data.status === "finishedSuccessfully") {
        yield put(stopFetchingStatusResources(instance.data.id));
      } else {
        yield delay(7000);
      }
    } catch (error) {
      yield put(stopFetchingStatusResources(instance.data.id));
    }
  }
}

type PollTask = {
  [id: number]: Task;
};

function cancelPolling(task: Task) {
  if (task) {
    task.cancel();
  }
}

function cancelStatusPolling(task: Task) {
  if (task) {
    task.cancel();
  }
}

function* watchCancelPoll(pollTask: Task) {
  yield takeEvery(ResourceTypes.STOP_FETCHING_PLUGIN_RESOURCES, function () {
    cancelPolling(pollTask);
  });
}

function* watchStatusCancelPoll(pollTask: PollTask) {
  yield takeEvery(
    ResourceTypes.STOP_FETCHING_STATUS_RESOURCES,
    function (action: IActionTypeParam) {
      const id = action.payload;
      const taskToCancel = pollTask[id];
      cancelStatusPolling(taskToCancel);
    }
  );
}

function* pollorCancelEndpoints(action: IActionTypeParam) {
  const instance = action.payload;
  const task = yield fork(handleGetPluginStatus, instance);
  yield watchCancelPoll(task);
}

function* pollInstanceEndpoints(action: IActionTypeParam) {
  const pluginInstances = action.payload.pluginInstances;

  const pollTask: {
    [id: number]: Task;
  } = {};

  for (let i = 0; i < pluginInstances.length; i++) {
    const instance = pluginInstances[i];
    const task = yield fork(handleGetInstanceStatus, instance);
    pollTask[instance.data.id] = task;
  }

  yield watchStatusCancelPoll(pollTask);
}

function* watchGetPluginFilesRequest() {
  yield takeEvery(
    ResourceTypes.GET_PLUGIN_FILES_REQUEST,
    pollorCancelEndpoints
  );
}

function* watchGetPluginStatusRequest() {
  yield takeEvery(
    ResourceTypes.GET_PLUGIN_STATUS_REQUEST,
    pollInstanceEndpoints
  );
}

export function* resourceSaga() {
  yield all([
    fork(watchGetPluginFilesRequest),
    fork(watchGetPluginStatusRequest),
  ]);
}

/**
 * Utility Functions
 */

function getLog(raw: string) {
  const strData = atob(raw);
  const data = inflate(strData);

  let output = "";
  for (let i = 0; i < data.length; i++) {
    output += String.fromCharCode(parseInt(data[i]));
  }

  return JSON.parse(output);
}