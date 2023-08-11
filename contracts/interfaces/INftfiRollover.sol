// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import "./ILoanCore.sol";

interface INftfiRollover {
    struct OperationData {
            uint256 loanId;
            address borrower;
            LoanLibrary.LoanTerms newLoanTerms;
            address lender;
            uint160 nonce;
            uint8 v;
            bytes32 r;
            bytes32 s;
    }

    function rolloverNftfiLoan(
        uint32 loanId,
        LoanLibrary.LoanTerms calldata newLoanTerms,
        address lender,
        uint160 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
