'use strict';

const config = require('config');

require('../../logger')('discord');

module.exports = async (context, oldMember, newMember) => {
  function roleChanged () {
    const removedRoleIds = [...oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id)).keys()];
    const addedRolesIds = [...newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id)).keys()];
    const allAffected = [...new Set(removedRoleIds.concat(addedRolesIds))];
    const dName = `${newMember.user.username}#${newMember.user.discriminator}`;

    function checkIfRoleChanged (roleId, ifRemoved, ifAdded) {
      if (allAffected.includes(roleId)) {
        if (removedRoleIds.includes(roleId)) {
          return ifRemoved(newMember.user.id);
        }

        if (addedRolesIds.includes(roleId)) {
          return ifAdded(newMember.user.id);
        }
      }
    }

    return [
      ['allowed speakers', config.app.allowedSpeakersRoleId, (mId) => {
        if (config.app.allowedSpeakersRemove(mId)) {
          return 'removed from';
        }
      }, (mId) => {
        if (config.app.allowedSpeakersAdd(mId)) {
          return 'added to';
        }
      }]
    ]
      .map(([readableName, roleId, ...funcs]) => [checkIfRoleChanged(roleId, ...funcs), readableName, roleId])
      .filter((res) => !!res[0])
      .map(([action, readableName, roleId]) => `${dName} was ${action} ${readableName} role (ID: ${roleId})`);
  }

  [roleChanged]
    .flatMap(f => f())
    .filter(res => res !== null)
    .forEach(as => console.log('Guild member change: ' + as));
};
