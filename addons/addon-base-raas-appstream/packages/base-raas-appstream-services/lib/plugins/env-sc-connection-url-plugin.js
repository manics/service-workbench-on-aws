/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 * http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

const _ = require('lodash');

const settingKeys = {
  isAppStreamEnabled: 'isAppStreamEnabled',
};

async function createConnectionUrl({ envId, connection }, { requestContext, container }) {
  const log = await container.find('log');
  // Only wraps web urls via app stream (i.e., scheme = 'http' or 'https' or no scheme)
  const isHttp = connection.scheme === 'http' || connection.scheme === 'https' || _.isEmpty(connection.scheme);
  const isSsh = connection.scheme === 'ssh';
  const isRdp = connection.scheme === 'rdp' || connection.scheme === 'customrdp';
  const appStreamScService = await container.find('appStreamScService');
  const environmentScConnectionService = await container.find('environmentScConnectionService');
  const environmentScService = await container.find("environmentScService");
  const settings = await container.find('settings');
  const isAppStreamEnabled = settings.getBoolean(settingKeys.isAppStreamEnabled);

  // This plugin will only contribute to URL creation when AppStream is enabled
  // Since this plugin is also called upon during listConnections cycle
  // it will only be triggered during the URL creation API call
  if (!isAppStreamEnabled || connection.operation === 'list') {
    return { envId, connection };
  }

  if (_.toLower(_.get(connection, 'type', '')) === 'sagemaker') {
    connection.url = await environmentScConnectionService.createPrivateSageMakerUrl(requestContext, envId, connection);
  }

  // Only wrap via AppStream if the connection.url exists
  let appStreamUrl;
  if (isHttp && connection.url) {
    log.debug({
      msg: `Target connection URL ${connection.url} will be accessible via AppStream URL`,
      connection,
    });
    appStreamUrl = await appStreamScService.getStreamingUrl(requestContext, {
      environmentId: envId,
      applicationId: 'firefox',
    });
  } else if (isSsh) {
    log.debug({
      msg: `Target instance ${connection.instanceId} will be available for SSH connection via AppStream URL`,
      connection,
    });
    const ec2 = await environmentScService.getClientSdkWithEnvMgmtRole(
      requestContext,
      { id: envId },
      { clientName: "EC2", options: { apiVersion: "2016-11-15" } }
    );
    const data = await ec2
      .describeInstances({ InstanceIds: [connection.instanceId] })
      .promise();
    const instanceInfo = _.get(data, "Reservations[0].Instances[0]");
    const networkInterfaces = _.get(instanceInfo, "NetworkInterfaces") || [];
    const privateIp = _.get(networkInterfaces[0], "PrivateIpAddress");
    appStreamUrl = await appStreamScService.getStreamingUrl(requestContext, {
      environmentId: envId,
      applicationId: 'terminal',
      sessionContext: `${privateIp},ec2-user`,
    });
  } else if (isRdp) {
    log.debug({
      msg: `Will stream target RDP connection for instance ${connection.instanceId} via AppStream`,
      connection,
    });
    appStreamUrl = await appStreamScService.urlForRemoteDesktop(requestContext, {
      environmentId: envId,
      instanceId: connection.instanceId,
    });
  }

  if (appStreamUrl) {
    // Retain the original destination URL so we don't have to trigger another API call
    connection.appstreamDestinationUrl = connection.url;

    // Now rewrite connection.url to the AppStream streaming URL so it can be opened in a new tab
    connection.url = appStreamUrl;
    log.debug({ msg: `Modified connection to use AppStream streaming URL ${connection.url}`, connection });
  }

  return { envId, connection };
}

const plugin = { createConnectionUrl };

module.exports = plugin;
